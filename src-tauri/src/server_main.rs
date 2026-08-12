// Servidor Web standalone do Alethe — expõe via HTTP/WebSocket (porta 1423)
// o mesmo backend que o app desktop usa via Tauri IPC, compartilhando
// `%LOCALAPPDATA%\com.kc1t.alethe` (perfis/projects.json) 100% sincronizado
// com a versão Desktop.
//
// Reaproveita a lógica de negócio de verdade sempre que possível — a maioria
// dos módulos em `lib.rs` foi tornada `pub` justamente pra isso. Módulos que
// só o desktop consegue rodar sem reescrever (dependem de `tauri::AppHandle`
// pra emitir evento ou resolver `app_data_dir`, ex.: PTY e Perfis) ainda
// ficam com uma implementação própria aqui — ver comentário em cada módulo
// de rota pra saber qual caso é qual.

// `server_main.rs` é o crate-root do binário `alethe-server` (`[[bin]] path =
// "src/server_main.rs"` no Cargo.toml) — submódulos de um crate-root sempre
// resolvem em `src/<nome>.rs` por padrão (mesma regra de `main.rs`/`lib.rs`),
// nunca em `src/server_main/<nome>.rs` só porque o arquivo se chama
// "server_main.rs". `#[path]` força a pasta própria (`src/server_main/`) só
// pra organização, sem depender dessa convenção.
#[path = "server_main/agent_routes.rs"]
mod agent_routes;
#[path = "server_main/fs_cli_routes.rs"]
mod fs_cli_routes;
#[path = "server_main/git_routes.rs"]
mod git_routes;
#[path = "server_main/graphify_routes.rs"]
mod graphify_routes;
#[path = "server_main/misc_routes.rs"]
mod misc_routes;
#[path = "server_main/profile_routes.rs"]
mod profile_routes;
#[path = "server_main/session_routes.rs"]
mod session_routes;

use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::CorsLayer;

/// Erro HTTP padrão de toda rota — a convenção deste projeto inteiro é
/// `Result<T, String>` (erros são um `code` curto tipo `not_a_git_repository`,
/// nunca uma mensagem livre pro usuário — a tradução pra texto exibível
/// acontece no FRONTEND via `readableError`/i18n, igual já acontecia com o
/// Tauri IPC). Preserva esse contrato: devolve o `String` cru no corpo, só
/// decide o STATUS CODE http em cima dele.
pub struct AppError(pub axum::http::StatusCode, pub String);

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        AppError(axum::http::StatusCode::BAD_REQUEST, message.into())
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        // A maioria dos erros deste backend é "não achou"/"não é um repo
        // git"/"comando falhou" — 400 é o padrão honesto pra "seu pedido não
        // pôde ser atendido como está" sem inventar uma taxonomia de erro
        // nova só pro modo web.
        AppError(axum::http::StatusCode::BAD_REQUEST, message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok", "mode": "web" }))
}

/// Qualquer rota que o cliente já sabe chamar (`src/lib/api/*.ts`) mas que
/// este servidor ainda não implementa. Devolve erro de verdade (501) em vez
/// de um `200 OK` falso — um `200` com formato errado é PIOR que um erro
/// claro: o frontend segue em frente achando que deu certo e quebra de
/// um jeito difícil de diagnosticar mais adiante (foi exatamente o que
/// aconteceu com `childError.slice is not a function` antes desta rota
/// existir — o catch-all antigo devolvia `200 {"status":"ok"}` pra
/// `/api/gsd/child_error`, que o cliente esperava ser uma string).
async fn not_implemented(uri: axum::http::Uri) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": "not_implemented", "path": uri.path() })),
    )
}

fn build_router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(profile_routes::router())
        .merge(git_routes::router())
        .merge(session_routes::router())
        .merge(agent_routes::router())
        .merge(graphify_routes::router())
        .merge(misc_routes::router())
        .merge(fs_cli_routes::router())
        .fallback(not_implemented)
        .layer(CorsLayer::permissive())
}

#[tokio::main]
async fn main() {
    println!("[Alethe Web Server] Inicializando servidor Alethe Web em http://127.0.0.1:1423 ...");

    let app = build_router();
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:1423").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[Alethe Web Server] Erro ao abrir porta 1423: {e}");
            return;
        }
    };

    println!("[Alethe Web Server] Servidor escutando na porta 1423 (REST + WebSockets)!");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[Alethe Web Server] Erro fatal no servidor: {e}");
    }
}
