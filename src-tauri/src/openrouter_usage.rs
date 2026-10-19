//! OpenRouter credit usage. The voice API key answers `/api/v1/key` (that key's spend, limit and
//! the budget that blocks it first); an optional management key answers `/api/v1/credits` (the
//! account balance) and `/api/v1/activity` (the last 30 completed UTC days). Neither key is ever
//! echoed in an error.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::secure_store::SecretKind;
use crate::voice_providers::http::{
    auth_headers, send, CloudError, CloudErrorKind, HttpBody, HttpMethod, HttpRequest,
};
use crate::voice_providers::keys::{
    delete_secret_async, read_key_async, read_secret_async, validate_key, write_secret_async,
};
use crate::voice_providers::CloudProvider;

const BASE_URL: &str = "https://openrouter.ai/api/v1";
const TIMEOUT: Duration = Duration::from_secs(15);
const TOP_MODELS: usize = 5;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterAccount {
    pub total_credits: f64,
    pub total_usage: f64,
    pub remaining: f64,
    pub used_percent: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterKeyUsage {
    pub label: String,
    pub usage: f64,
    pub usage_daily: f64,
    pub usage_weekly: f64,
    pub usage_monthly: f64,
    pub limit: Option<f64>,
    pub limit_remaining: Option<f64>,
    pub limit_reset: Option<String>,
    pub is_free_tier: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterBudget {
    pub limit_usd: f64,
    pub spend_usd: f64,
    pub remaining_usd: f64,
    pub reset_interval: Option<String>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterDailySpend {
    pub date: String,
    pub usage: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterModelSpend {
    pub model: String,
    pub usage: f64,
    pub requests: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterActivity {
    pub spend_7d: f64,
    pub spend_30d: f64,
    pub requests_30d: u64,
    pub daily: Vec<OpenRouterDailySpend>,
    pub top_models: Vec<OpenRouterModelSpend>,
}

/// The tightest known cap: the one with the least left.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterHeadline {
    /// account | key | budget
    pub source: &'static str,
    pub used_percent: f64,
    pub remaining_usd: f64,
    pub total_usd: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OpenRouterUsage {
    /// ready | no_key | unavailable
    pub status: &'static str,
    pub has_api_key: bool,
    pub has_management_key: bool,
    /// auth | network | other
    pub key_error: Option<&'static str>,
    pub management_error: Option<&'static str>,
    pub account: Option<OpenRouterAccount>,
    pub key: Option<OpenRouterKeyUsage>,
    pub budget: Option<OpenRouterBudget>,
    pub activity: Option<OpenRouterActivity>,
    pub headline: Option<OpenRouterHeadline>,
    pub daily_burn_usd: Option<f64>,
    pub days_left: Option<f64>,
}

fn error_code(error: &CloudError) -> &'static str {
    match error.kind {
        CloudErrorKind::Auth => "auth",
        CloudErrorKind::Network | CloudErrorKind::Timeout => "network",
        _ => "other",
    }
}

fn get(path: &str, key: &str) -> HttpRequest {
    HttpRequest {
        method: HttpMethod::Get,
        url: format!("{BASE_URL}{path}"),
        headers: auth_headers(CloudProvider::Openrouter, key),
        body: HttpBody::Empty,
        audio: false,
    }
}

fn json(body: &[u8]) -> Option<Value> {
    serde_json::from_slice(body).ok()
}

fn num(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// True when `/api/v1/key` describes a key that manages keys rather than calling models.
pub fn is_management_key(data: &Value) -> bool {
    data["is_management_key"].as_bool() == Some(true)
        || data["is_provisioning_key"].as_bool() == Some(true)
}

/// `/api/v1/key` for an API key: its own spend and the budget that blocks it first.
pub fn parse_key(body: &[u8]) -> Option<(Option<OpenRouterKeyUsage>, Option<OpenRouterBudget>)> {
    let value = json(body)?;
    let data = value.get("data").filter(|data| data.is_object())?;
    let key = (!is_management_key(data)).then(|| OpenRouterKeyUsage {
        label: text(&data["label"]).unwrap_or_default(),
        usage: num(&data["usage"]).unwrap_or(0.0),
        usage_daily: num(&data["usage_daily"]).unwrap_or(0.0),
        usage_weekly: num(&data["usage_weekly"]).unwrap_or(0.0),
        usage_monthly: num(&data["usage_monthly"]).unwrap_or(0.0),
        limit: num(&data["limit"]),
        limit_remaining: num(&data["limit_remaining"]),
        limit_reset: text(&data["limit_reset"]),
        is_free_tier: data["is_free_tier"].as_bool().unwrap_or(false),
    });
    let budget = &data["effective_budget"];
    let budget = num(&budget["limit_usd"]).map(|limit_usd| {
        let spend_usd = num(&budget["spend_usd"]).unwrap_or(0.0);
        OpenRouterBudget {
            limit_usd,
            spend_usd,
            remaining_usd: num(&budget["remaining_usd"])
                .unwrap_or(limit_usd - spend_usd)
                .max(0.0),
            reset_interval: text(&budget["reset_interval"]),
            resets_at: text(&budget["resets_at"]),
        }
    });
    Some((key, budget))
}

fn used_percent(total: f64, remaining: f64) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    ((total - remaining) / total * 100.0).clamp(0.0, 100.0)
}

/// `/api/v1/credits`: credits bought and spent over the account's life.
pub fn parse_credits(body: &[u8]) -> Option<OpenRouterAccount> {
    let value = json(body)?;
    let total_credits = num(&value["data"]["total_credits"])?;
    let total_usage = num(&value["data"]["total_usage"])?;
    let remaining = (total_credits - total_usage).max(0.0);
    Some(OpenRouterAccount {
        total_credits,
        total_usage,
        remaining,
        used_percent: used_percent(total_credits, remaining),
    })
}

fn epoch_day(date: &str) -> Option<i64> {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1)?;
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Some(day.signed_duration_since(epoch).num_days())
}

fn today_epoch_day() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| (elapsed.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

/// `/api/v1/activity` rows summed per day and per model. `today` is the current UTC day counted
/// from the epoch; the 7-day spend covers the seven completed days before it.
pub fn parse_activity(body: &[u8], today: i64) -> Option<OpenRouterActivity> {
    let value = json(body)?;
    let rows = value["data"].as_array()?;
    let mut spend_7d = 0.0;
    let mut spend_30d = 0.0;
    let mut requests_30d = 0;
    let mut daily: BTreeMap<String, f64> = BTreeMap::new();
    let mut models: BTreeMap<String, (f64, u64)> = BTreeMap::new();
    for row in rows {
        let usage = num(&row["usage"]).unwrap_or(0.0);
        let requests = row["requests"].as_u64().unwrap_or(0);
        spend_30d += usage;
        requests_30d += requests;
        if let Some(date) = row["date"].as_str() {
            // The API may send a full timestamp; the day is its first ten characters.
            let day = date.get(..10).unwrap_or(date);
            *daily.entry(day.to_string()).or_default() += usage;
            if epoch_day(day).is_some_and(|d| d < today && d >= today - 7) {
                spend_7d += usage;
            }
        }
        if let Some(model) = row["model"].as_str() {
            let entry = models.entry(model.to_string()).or_default();
            entry.0 += usage;
            entry.1 += requests;
        }
    }
    let mut top_models: Vec<OpenRouterModelSpend> = models
        .into_iter()
        .map(|(model, (usage, requests))| OpenRouterModelSpend {
            model,
            usage,
            requests,
        })
        .collect();
    top_models.sort_by(|a, b| b.usage.total_cmp(&a.usage));
    top_models.truncate(TOP_MODELS);
    Some(OpenRouterActivity {
        spend_7d,
        spend_30d,
        requests_30d,
        daily: daily
            .into_iter()
            .map(|(date, usage)| OpenRouterDailySpend { date, usage })
            .collect(),
        top_models,
    })
}

/// The cap with the least left among the account balance, the key limit and the budget.
pub fn headline(
    account: Option<&OpenRouterAccount>,
    key: Option<&OpenRouterKeyUsage>,
    budget: Option<&OpenRouterBudget>,
) -> Option<OpenRouterHeadline> {
    let mut candidates: Vec<(&'static str, f64, f64)> = Vec::new();
    if let Some(account) = account.filter(|a| a.total_credits > 0.0) {
        candidates.push(("account", account.remaining, account.total_credits));
    }
    if let Some(key) = key {
        if let Some(limit) = key.limit.filter(|limit| *limit > 0.0) {
            let remaining = key.limit_remaining.unwrap_or(limit - key.usage);
            candidates.push(("key", remaining, limit));
        }
    }
    if let Some(budget) = budget.filter(|b| b.limit_usd > 0.0) {
        candidates.push(("budget", budget.remaining_usd, budget.limit_usd));
    }
    candidates
        .into_iter()
        .map(|(source, remaining, total)| (source, remaining.max(0.0), total))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(source, remaining_usd, total_usd)| OpenRouterHeadline {
            source,
            used_percent: used_percent(total_usd, remaining_usd),
            remaining_usd,
            total_usd,
        })
}

/// Average spend per day over the last week: from activity when known, else from the key.
pub fn daily_burn(
    activity: Option<&OpenRouterActivity>,
    key: Option<&OpenRouterKeyUsage>,
) -> Option<f64> {
    let weekly = match activity {
        Some(activity) => activity.spend_7d,
        None => key?.usage_weekly,
    };
    let burn = weekly / 7.0;
    (burn > 0.0).then_some(burn)
}

/// Joins what each fetch returned into the reading sent to the frontend.
pub fn assemble(
    has_api_key: bool,
    has_management_key: bool,
    key_reply: Option<Result<Vec<u8>, CloudError>>,
    credits_reply: Option<Result<Vec<u8>, CloudError>>,
    activity_reply: Option<Result<Vec<u8>, CloudError>>,
    today: i64,
) -> OpenRouterUsage {
    let mut key_error = None;
    let (key, budget) = match key_reply {
        Some(Ok(body)) => parse_key(&body).unwrap_or_else(|| {
            key_error = Some("other");
            (None, None)
        }),
        Some(Err(error)) => {
            key_error = Some(error_code(&error));
            (None, None)
        }
        None => (None, None),
    };
    let mut management_error = None;
    let account = match credits_reply {
        Some(Ok(body)) => parse_credits(&body).or_else(|| {
            management_error = Some("other");
            None
        }),
        Some(Err(error)) => {
            management_error = Some(error_code(&error));
            None
        }
        None => None,
    };
    let activity = match activity_reply {
        Some(Ok(body)) => parse_activity(&body, today),
        Some(Err(error)) => {
            management_error.get_or_insert(error_code(&error));
            None
        }
        None => None,
    };
    let headline = headline(account.as_ref(), key.as_ref(), budget.as_ref());
    let daily_burn_usd = daily_burn(activity.as_ref(), key.as_ref());
    let days_left = match (&headline, daily_burn_usd) {
        (Some(headline), Some(burn)) if headline.remaining_usd > 0.0 && burn > 0.0 => {
            Some(headline.remaining_usd / burn)
        }
        _ => None,
    };
    let status = if account.is_some() || key.is_some() || budget.is_some() || activity.is_some() {
        "ready"
    } else if !has_api_key && !has_management_key {
        "no_key"
    } else {
        "unavailable"
    };
    OpenRouterUsage {
        status,
        has_api_key,
        has_management_key,
        key_error,
        management_error,
        account,
        key,
        budget,
        activity,
        headline,
        daily_burn_usd,
        days_left,
    }
}

async fn fetch(path: &'static str, key: Option<&str>) -> Option<Result<Vec<u8>, CloudError>> {
    Some(send(get(path, key?), TIMEOUT).await)
}

#[tauri::command]
pub async fn get_openrouter_usage(app: AppHandle) -> Result<OpenRouterUsage, String> {
    let (api_key, management_key) = tokio::join!(
        read_key_async(&app, CloudProvider::Openrouter),
        read_secret_async(&app, SecretKind::OpenrouterManagementKey),
    );
    let api_key = api_key?;
    let management_key = management_key?;
    let (key_reply, credits_reply, activity_reply) = tokio::join!(
        fetch("/key", api_key.as_deref()),
        fetch("/credits", management_key.as_deref()),
        fetch("/activity", management_key.as_deref()),
    );
    Ok(assemble(
        api_key.is_some(),
        management_key.is_some(),
        key_reply,
        credits_reply,
        activity_reply,
        today_epoch_day(),
    ))
}

/// Saves a management key after OpenRouter confirms it is one; an API key is refused so the
/// balance is never read with a key that cannot see it.
#[tauri::command]
pub async fn openrouter_set_management_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    let body =
        send(get("/key", &key), TIMEOUT)
            .await
            .map_err(|error| match error_code(&error) {
                "auth" => "openrouter_key_rejected",
                "network" => "openrouter_network",
                _ => "openrouter_other",
            })?;
    let is_management = json(&body)
        .and_then(|value| value.get("data").map(is_management_key))
        .unwrap_or(false);
    if !is_management {
        return Err("openrouter_not_management_key".into());
    }
    write_secret_async(&app, SecretKind::OpenrouterManagementKey, key).await
}

#[tauri::command]
pub async fn openrouter_delete_management_key(app: AppHandle) -> Result<(), String> {
    delete_secret_async(&app, SecretKind::OpenrouterManagementKey).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = br#"{"data":{"label":"sk-or-v1-au7...890","usage":25.5,"usage_daily":1.5,"usage_weekly":14,"usage_monthly":25.5,"limit":100,"limit_remaining":74.5,"limit_reset":"monthly","is_free_tier":false,"is_management_key":false,"is_provisioning_key":false,"effective_budget":{"limit_usd":50,"spend_usd":32.5,"remaining_usd":17.5,"reset_interval":"weekly","resets_at":"2026-10-12T00:00:00.000Z"}}}"#;
    const CREDITS: &[u8] = br#"{"data":{"total_credits":100.5,"total_usage":25.75}}"#;

    fn day(date: &str) -> i64 {
        epoch_day(date).unwrap()
    }

    #[test]
    fn key_replies_carry_spend_limit_and_budget() {
        let (key, budget) = parse_key(KEY).unwrap();
        let key = key.unwrap();
        assert_eq!(key.label, "sk-or-v1-au7...890");
        assert_eq!(key.usage_weekly, 14.0);
        assert_eq!(key.limit, Some(100.0));
        assert_eq!(key.limit_remaining, Some(74.5));
        assert_eq!(key.limit_reset.as_deref(), Some("monthly"));
        let budget = budget.unwrap();
        assert_eq!(budget.remaining_usd, 17.5);
        assert_eq!(budget.reset_interval.as_deref(), Some("weekly"));
    }

    #[test]
    fn a_key_without_limit_or_budget_reads_as_none() {
        let (key, budget) =
            parse_key(br#"{"data":{"label":"x","usage":3,"limit":null,"limit_remaining":null,"effective_budget":null}}"#)
                .unwrap();
        let key = key.unwrap();
        assert_eq!(key.limit, None);
        assert_eq!(key.limit_remaining, None);
        assert!(budget.is_none());
        assert!(parse_key(b"not json").is_none());
    }

    #[test]
    fn management_keys_have_no_key_usage() {
        let (key, _) =
            parse_key(br#"{"data":{"label":"m","is_management_key":true,"usage":0}}"#).unwrap();
        assert!(key.is_none());
        let (key, _) = parse_key(br#"{"data":{"label":"m","is_provisioning_key":true}}"#).unwrap();
        assert!(key.is_none());
    }

    #[test]
    fn credits_give_the_balance() {
        let account = parse_credits(CREDITS).unwrap();
        assert_eq!(account.remaining, 74.75);
        assert!((account.used_percent - 25.62).abs() < 0.01);
        let spent = parse_credits(br#"{"data":{"total_credits":10,"total_usage":12}}"#).unwrap();
        assert_eq!(spent.remaining, 0.0);
        assert_eq!(spent.used_percent, 100.0);
        assert!(parse_credits(br#"{"data":{}}"#).is_none());
    }

    #[test]
    fn activity_sums_days_week_and_models() {
        let today = day("2026-10-16");
        let body = br#"{"data":[
            {"date":"2026-10-15","model":"a/x","usage":1.0,"requests":2},
            {"date":"2026-10-15","model":"b/y","usage":3.0,"requests":1},
            {"date":"2026-10-09","model":"a/x","usage":0.5,"requests":4},
            {"date":"2026-10-08","model":"c/z","usage":2.0,"requests":1},
            {"date":"2026-10-16","model":"c/z","usage":9.0,"requests":1}
        ]}"#;
        let activity = parse_activity(body, today).unwrap();
        // 10-09..10-15 is the window; 10-08 is outside and today is not completed.
        assert_eq!(activity.spend_7d, 4.5);
        assert_eq!(activity.spend_30d, 15.5);
        assert_eq!(activity.requests_30d, 9);
        assert_eq!(activity.daily.first().unwrap().date, "2026-10-08");
        assert_eq!(activity.daily[2].usage, 4.0);
        let order: Vec<&str> = activity
            .top_models
            .iter()
            .map(|m| m.model.as_str())
            .collect();
        assert_eq!(order, ["c/z", "b/y", "a/x"]);
        assert_eq!(activity.top_models[2].requests, 6);
    }

    #[test]
    fn top_models_are_capped() {
        let rows: Vec<String> = (0..8)
            .map(|i| format!(r#"{{"date":"2026-10-15","model":"m{i}","usage":{i},"requests":1}}"#))
            .collect();
        let body = format!(r#"{{"data":[{}]}}"#, rows.join(","));
        let activity = parse_activity(body.as_bytes(), day("2026-10-16")).unwrap();
        assert_eq!(activity.top_models.len(), TOP_MODELS);
        assert_eq!(activity.top_models[0].model, "m7");
    }

    #[test]
    fn the_headline_is_the_cap_with_least_left() {
        let account = parse_credits(CREDITS).unwrap();
        let (key, budget) = parse_key(KEY).unwrap();
        let line = headline(Some(&account), key.as_ref(), budget.as_ref()).unwrap();
        assert_eq!(line.source, "budget");
        assert_eq!(line.remaining_usd, 17.5);
        assert_eq!(line.used_percent, 65.0);
        let line = headline(Some(&account), key.as_ref(), None).unwrap();
        assert_eq!(line.source, "key");
        let line = headline(Some(&account), None, None).unwrap();
        assert_eq!(line.source, "account");
        assert!(headline(None, None, None).is_none());
    }

    #[test]
    fn burn_and_days_left_follow_the_week() {
        let (key, budget) = parse_key(KEY).unwrap();
        assert_eq!(daily_burn(None, key.as_ref()), Some(2.0));
        let usage = assemble(true, false, Some(Ok(KEY.to_vec())), None, None, 0);
        assert_eq!(usage.daily_burn_usd, Some(2.0));
        assert_eq!(usage.days_left, Some(17.5 / 2.0));
        assert_eq!(budget.unwrap().limit_usd, 50.0);
        let idle = OpenRouterActivity {
            spend_7d: 0.0,
            spend_30d: 1.0,
            requests_30d: 1,
            daily: vec![],
            top_models: vec![],
        };
        // Activity, when present, wins over the key even when it shows no spend.
        assert_eq!(daily_burn(Some(&idle), key.as_ref()), None);
    }

    #[test]
    fn status_reflects_keys_and_replies() {
        assert_eq!(assemble(false, false, None, None, None, 0).status, "no_key");
        let failed = assemble(
            true,
            true,
            Some(Err(CloudError::of(CloudErrorKind::Auth))),
            Some(Err(CloudError::of(CloudErrorKind::Timeout))),
            Some(Err(CloudError::of(CloudErrorKind::Other))),
            0,
        );
        assert_eq!(failed.status, "unavailable");
        assert_eq!(failed.key_error, Some("auth"));
        assert_eq!(failed.management_error, Some("network"));
        let ready = assemble(
            false,
            true,
            None,
            Some(Ok(CREDITS.to_vec())),
            Some(Ok(br#"{"data":[]}"#.to_vec())),
            0,
        );
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.headline.unwrap().source, "account");
        assert_eq!(ready.days_left, None);
    }

    #[test]
    fn the_reading_serializes_in_snake_case() {
        let usage = assemble(true, false, Some(Ok(KEY.to_vec())), None, None, 0);
        let value = serde_json::to_value(&usage).unwrap();
        for field in [
            "status",
            "has_api_key",
            "has_management_key",
            "key_error",
            "management_error",
            "account",
            "key",
            "budget",
            "activity",
            "headline",
            "daily_burn_usd",
            "days_left",
        ] {
            assert!(value.get(field).is_some(), "missing {field}");
        }
        assert_eq!(value["key"]["limit_remaining"], 74.5);
        assert!(value["account"].is_null());
    }
}
