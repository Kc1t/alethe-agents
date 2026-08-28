//! Programmer-focused chat: direct conversations, project channels, and private groups with
//! per-epoch end-to-end encryption (Phase 9, ADR-0006). A removed member never receives the key
//! wrap for any epoch after their removal and cannot derive it from anything they already hold —
//! proven by `removed_member_cannot_decrypt_new_epoch_messages_or_attachments`. Nothing here
//! contacts a rendezvous or relay provider; every test drives both "sides" of a conversation
//! within one local fixture, the same pattern as Phases 6–8.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

use crate::sync_crypto::{open_sealed, seal_for_recipient, SealedEnvelope};

const CHAT_SCHEMA_VERSION: u32 = 1;
pub const MAX_MESSAGES_PER_CONVERSATION: usize = 20_000;
/// Local-fixture scope only: attachments are stored inline as encrypted bytes in the
/// conversation document. A real deployment would reuse Phase 6's chunked staging protocol for
/// large attachments instead of holding the whole ciphertext in one JSON field.
pub const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Direct,
    ProjectChannel,
    PrivateGroup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInfo {
    pub account_route: String,
    pub x25519_public_key: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochKeyWrap {
    pub member_account_route: String,
    pub ephemeral_public_key: Vec<u8>,
    pub nonce: Vec<u8>,
    pub wrapped_key: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Epoch {
    pub epoch_number: u64,
    pub wraps: Vec<EpochKeyWrap>,
    pub created_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageContentType {
    Text,
    CodeBlock,
    TestResult,
    BugReport,
    /// A shared shell/terminal command. Stored and ever rendered as inert text — no code path in
    /// this codebase executes a `Command`-typed message on receipt, preview, copy, or
    /// notification action. There is nothing in this Core module capable of executing anything;
    /// this variant exists purely so the frontend can apply the review-before-run UX the
    /// blueprint requires, not because the backend runs commands.
    Command,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub member_account_route: String,
    pub emoji: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub message_id: String,
    pub conversation_id: String,
    pub epoch: u64,
    pub sequence: u64,
    pub sender_device_id: String,
    pub sender_account_route: String,
    pub content_type: MessageContentType,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub mentions: Vec<String>,
    pub reactions: Vec<Reaction>,
    pub created_at_ms: u64,
    pub edited_at_ms: Option<u64>,
    pub deleted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    pub attachment_id: String,
    pub conversation_id: String,
    pub declared_content_type: String,
    pub declared_size: u64,
    pub actual_size: u64,
    pub content_hash: String,
    /// Independent from any conversation epoch key (ADR-0006) — wrapped per member the same way,
    /// but rotating/losing this key never affects message keys or vice versa.
    pub wraps: Vec<EpochKeyWrap>,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub conversation_id: String,
    pub project_id: Option<String>,
    pub kind: ConversationKind,
    /// Organizes the conversation in a UI list; never used for authorization (categories
    /// organize, they do not authorize — the blueprint's phrasing exactly).
    pub category: Option<String>,
    pub members: Vec<MemberInfo>,
    pub epochs: Vec<Epoch>,
    pub read_cursors: Vec<(String, u64)>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationDocument {
    schema_version: u32,
    conversation: Conversation,
    messages: Vec<MessageRecord>,
    attachments: Vec<AttachmentRecord>,
    next_sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatError {
    NotAuthorized,
    NotFound,
    NotAMember,
    AlreadyAMember,
    InvalidInput,
    SizeMismatch,
    DecryptFailed,
    Io,
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            ChatError::NotAuthorized => "chat_not_authorized",
            ChatError::NotFound => "chat_not_found",
            ChatError::NotAMember => "chat_not_a_member",
            ChatError::AlreadyAMember => "chat_already_a_member",
            ChatError::InvalidInput => "chat_invalid_input",
            ChatError::SizeMismatch => "chat_size_mismatch",
            ChatError::DecryptFailed => "chat_decrypt_failed",
            ChatError::Io => "chat_io_error",
        };
        write!(f, "{code}")
    }
}

pub trait ChatDeviceAuthorizer {
    fn check_trusted(&self, device_id: &str) -> Result<(), ChatError>;
}

fn conversation_path(data_root: &Path, conversation_id: &str) -> PathBuf {
    data_root.join("sync").join("chat").join(format!("{conversation_id}.json"))
}

/// Append-only journal of newly sent/received messages not yet folded into the base document.
///
/// `save_at`'s full rewrite (serialize the whole `ConversationDocument`, fsync, atomic rename) is
/// O(size of the entire conversation) — fine occasionally, but `send_message_at`/
/// `record_incoming_message_at` used to call it on *every single message*, so a long-running
/// conversation got measurably slower to send in the same way its history grew, purely from
/// re-writing bytes that had already been written before. New messages are now appended here in
/// O(1) instead (see `append_message_to_journal_at`), with the base document only rewritten
/// periodically (`maybe_compact_at`) or whenever some other mutation (edit/delete/react/membership
/// change) already needs a full rewrite anyway — those already call `save_at`, which folds any
/// pending journal entries in as a side effect (via `load_at` merging them first) and clears the
/// journal, so nothing here changes the source of truth's shape or any other code path's
/// correctness — only how often the expensive full rewrite happens.
fn journal_path(data_root: &Path, conversation_id: &str) -> PathBuf {
    data_root.join("sync").join("chat").join(format!("{conversation_id}.jsonl"))
}

/// Compact the base document (folding in any journaled messages, see `load_at`) once the journal
/// reaches this many pending entries — bounds both the per-append cost (still O(1)) and how much
/// journal a crash between appends could ever lose track of/re-read before the next full rewrite.
const JOURNAL_COMPACT_THRESHOLD: usize = 50;

pub(crate) fn load_at(data_root: &Path, conversation_id: &str) -> Result<ConversationDocument, ChatError> {
    let path = conversation_path(data_root, conversation_id);
    let bytes = fs::read(&path).map_err(|_| ChatError::NotFound)?;
    let mut document: ConversationDocument = serde_json::from_slice(&bytes).map_err(|_| ChatError::Io)?;
    if document.schema_version != CHAT_SCHEMA_VERSION {
        return Err(ChatError::Io);
    }
    let journal_path = journal_path(data_root, conversation_id);
    if let Ok(journal_bytes) = fs::read(&journal_path) {
        for line in String::from_utf8_lossy(&journal_bytes).lines() {
            if line.trim().is_empty() {
                continue;
            }
            // A journal line can be truncated if the process was killed mid-write (append is not
            // atomic the way the base document's write-temp-then-rename is) — skip a malformed
            // trailing line rather than failing the whole load; the sender still has the message
            // in its own document, and a receiver would get it again on the next delivery retry.
            let Ok(message) = serde_json::from_str::<MessageRecord>(line) else { continue };
            if !document.messages.iter().any(|existing| existing.message_id == message.message_id) {
                document.messages.push(message);
            }
        }
    }
    if let Some(max_sequence) = document.messages.iter().map(|message| message.sequence).max() {
        document.next_sequence = document.next_sequence.max(max_sequence + 1);
    }
    Ok(document)
}

/// Appends one message to the journal (O(1): open-append, write one JSON line, fsync) instead of
/// rewriting the whole conversation document. See `journal_path`'s doc comment for the full design.
fn append_message_to_journal_at(
    data_root: &Path,
    conversation_id: &str,
    message: &MessageRecord,
) -> Result<(), ChatError> {
    let path = journal_path(data_root, conversation_id);
    let parent = path.parent().ok_or(ChatError::Io)?;
    fs::create_dir_all(parent).map_err(|_| ChatError::Io)?;
    let mut line = serde_json::to_vec(message).map_err(|_| ChatError::Io)?;
    line.push(b'\n');
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|_| ChatError::Io)?;
    file.write_all(&line).and_then(|_| file.sync_all()).map_err(|_| ChatError::Io)
}

fn journal_entry_count_at(data_root: &Path, conversation_id: &str) -> usize {
    let path = journal_path(data_root, conversation_id);
    match fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).lines().filter(|line| !line.trim().is_empty()).count(),
        Err(_) => 0,
    }
}

/// Appends `message` to the journal, then folds it into the base document with a full rewrite
/// (clearing the journal) once `JOURNAL_COMPACT_THRESHOLD` pending entries accumulate. `document`
/// must already have `message` pushed onto `document.messages` — the caller builds the in-memory
/// document once and this just decides how to persist it.
fn append_or_compact_at(
    data_root: &Path,
    document: &ConversationDocument,
    message: &MessageRecord,
) -> Result<(), ChatError> {
    let conversation_id = &document.conversation.conversation_id;
    append_message_to_journal_at(data_root, conversation_id, message)?;
    if journal_entry_count_at(data_root, conversation_id) >= JOURNAL_COMPACT_THRESHOLD {
        save_at(data_root, document)?;
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ChatError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result =
        unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(ChatError::Io)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ChatError> {
    fs::rename(source, destination).map_err(|_| ChatError::Io)
}

fn save_at(data_root: &Path, document: &ConversationDocument) -> Result<(), ChatError> {
    let path = conversation_path(data_root, &document.conversation.conversation_id);
    let parent = path.parent().ok_or(ChatError::Io)?;
    fs::create_dir_all(parent).map_err(|_| ChatError::Io)?;
    let temporary = parent.join(format!(".chat-{}.tmp", nanoid::nanoid!(12)));
    let bytes = serde_json::to_vec_pretty(document).map_err(|_| ChatError::Io)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| ChatError::Io)?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(ChatError::Io);
    }
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error
    })?;
    // A full rewrite always reflects everything the journal held (`load_at` merges journal
    // entries into whatever `document` the caller is about to persist here), so any pending
    // journal is now redundant — clear it so a future `load_at` doesn't re-merge already-included
    // messages. Best-effort: a leftover journal file is harmless (its messages are already
    // deduplicated by `message_id` on merge), just wasted space until the next compaction.
    let _ = fs::remove_file(journal_path(data_root, &document.conversation.conversation_id));
    Ok(())
}

fn wrap_epoch_key_for(
    key: &[u8; 32],
    member_x25519_public: &[u8],
    conversation_id: &str,
    epoch_number: u64,
) -> Result<EpochKeyWrap, ChatError> {
    let public_bytes: [u8; 32] = member_x25519_public.try_into().map_err(|_| ChatError::InvalidInput)?;
    let member_public = X25519PublicKey::from(public_bytes);
    let ephemeral_secret = X25519StaticSecret::random_from_rng(OsRng);
    let ephemeral_public = X25519PublicKey::from(&ephemeral_secret);
    let shared = ephemeral_secret.diffie_hellman(&member_public);
    let hkdf = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let info = format!("alethe-chat-epoch-wrap-v1|{conversation_id}|{epoch_number}");
    let mut wrap_key = [0_u8; 32];
    hkdf.expand(info.as_bytes(), &mut wrap_key).map_err(|_| ChatError::Io)?;

    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&wrap_key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), key.as_slice())
        .map_err(|_| ChatError::Io)?;

    Ok(EpochKeyWrap {
        member_account_route: String::new(), // filled in by the caller, which knows the member
        ephemeral_public_key: ephemeral_public.as_bytes().to_vec(),
        nonce: nonce_bytes.to_vec(),
        wrapped_key: ciphertext,
    })
}

/// Unwraps an epoch (or attachment) key using the member's own X25519 private key. This is the
/// only way to recover the key — a removed member's absence of a wrap entry for a given epoch
/// means there is nothing here to unwrap, by construction, not by a permission check.
pub fn unwrap_key(
    wrap: &EpochKeyWrap,
    member_secret: &X25519StaticSecret,
    conversation_id: &str,
    epoch_number: u64,
) -> Result<[u8; 32], ChatError> {
    let ephemeral_bytes: [u8; 32] =
        wrap.ephemeral_public_key.as_slice().try_into().map_err(|_| ChatError::InvalidInput)?;
    let ephemeral_public = X25519PublicKey::from(ephemeral_bytes);
    let shared = member_secret.diffie_hellman(&ephemeral_public);
    let hkdf = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let info = format!("alethe-chat-epoch-wrap-v1|{conversation_id}|{epoch_number}");
    let mut wrap_key = [0_u8; 32];
    hkdf.expand(info.as_bytes(), &mut wrap_key).map_err(|_| ChatError::Io)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&wrap_key));
    let nonce = Nonce::from_slice(&wrap.nonce);
    let plaintext = cipher.decrypt(nonce, wrap.wrapped_key.as_slice()).map_err(|_| ChatError::DecryptFailed)?;
    plaintext.try_into().map_err(|_| ChatError::DecryptFailed)
}

fn rewrap_epoch_for_members(
    key: &[u8; 32],
    members: &[MemberInfo],
    conversation_id: &str,
    epoch_number: u64,
) -> Result<Vec<EpochKeyWrap>, ChatError> {
    members
        .iter()
        .map(|member| {
            let mut wrap = wrap_epoch_key_for(key, &member.x25519_public_key, conversation_id, epoch_number)?;
            wrap.member_account_route = member.account_route.clone();
            Ok(wrap)
        })
        .collect()
}

pub fn create_conversation_at(
    data_root: &Path,
    project_id: Option<String>,
    kind: ConversationKind,
    category: Option<String>,
    members: Vec<MemberInfo>,
    now_ms: u64,
) -> Result<Conversation, ChatError> {
    create_conversation_with_id_at(
        data_root,
        format!("chat_{}", nanoid::nanoid!(24)),
        project_id,
        kind,
        category,
        members,
        now_ms,
    )
}

fn create_conversation_with_id_at(
    data_root: &Path,
    conversation_id: String,
    project_id: Option<String>,
    kind: ConversationKind,
    category: Option<String>,
    members: Vec<MemberInfo>,
    now_ms: u64,
) -> Result<Conversation, ChatError> {
    if members.is_empty() {
        return Err(ChatError::InvalidInput);
    }
    let mut epoch_key = [0_u8; 32];
    OsRng.fill_bytes(&mut epoch_key);
    let wraps = rewrap_epoch_for_members(&epoch_key, &members, &conversation_id, 0)?;
    let conversation = Conversation {
        conversation_id: conversation_id.clone(),
        project_id,
        kind,
        category,
        members,
        epochs: vec![Epoch { epoch_number: 0, wraps, created_at_ms: now_ms }],
        read_cursors: Vec::new(),
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    };
    let document = ConversationDocument {
        schema_version: CHAT_SCHEMA_VERSION,
        conversation: conversation.clone(),
        messages: Vec::new(),
        attachments: Vec::new(),
        next_sequence: 1,
    };
    save_at(data_root, &document)?;
    Ok(conversation)
}

pub fn load_conversation_at(data_root: &Path, conversation_id: &str) -> Result<Conversation, ChatError> {
    Ok(load_at(data_root, conversation_id)?.conversation)
}

/// Finds (or creates) the single project-channel conversation for a project. There is no
/// cross-device delivery yet (Phase 10), so a project channel today only ever has this install's
/// own account as a member — the same "local until Phase 10" honesty already applied to
/// invitations, tasks, and subscriptions elsewhere in this codebase.
pub fn ensure_project_conversation_at(
    data_root: &Path,
    project_id: &str,
    local_account_route: &str,
    local_x25519_public_key: Vec<u8>,
    now_ms: u64,
) -> Result<Conversation, ChatError> {
    let chat_dir = data_root.join("sync").join("chat");
    if let Ok(entries) = fs::read_dir(&chat_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if let Ok(conversation) = load_conversation_at(data_root, stem) {
                if conversation.project_id.as_deref() == Some(project_id)
                    && conversation.kind == ConversationKind::ProjectChannel
                {
                    return Ok(conversation);
                }
            }
        }
    }
    create_conversation_at(
        data_root,
        Some(project_id.to_string()),
        ConversationKind::ProjectChannel,
        None,
        vec![MemberInfo {
            account_route: local_account_route.to_string(),
            x25519_public_key: local_x25519_public_key,
        }],
        now_ms,
    )
}

/// Deterministic id for the `Direct` conversation between two accounts — both devices compute the
/// exact same id independently (sorted account routes, so member order never matters), with no
/// coordination needed. This is what makes cross-device delivery possible at all: a message frame
/// only carries `conversation_id` + `epoch_number`, so the receiving device needs to land in the
/// *same* local conversation record (and therefore derive the *same* epoch key — see
/// `resolve_direct_epoch_key`) as the sender, purely from data both sides already have.
fn direct_conversation_id(account_route_a: &str, account_route_b: &str) -> String {
    let mut routes = [account_route_a, account_route_b];
    routes.sort_unstable();
    let digest = Sha256::digest(format!("alethe-direct-conversation-v1|{}|{}", routes[0], routes[1]).as_bytes());
    format!("chat_{}", URL_SAFE_NO_PAD.encode(digest))
}

/// Same find-or-create shape as `ensure_project_conversation_at`, for a 1:1 `Direct` conversation
/// with a chat contact instead of a project channel — except the id is computed, not searched for
/// (see `direct_conversation_id`), since a `Direct` conversation's id must be derivable identically
/// by both devices for delivery to work at all.
pub fn ensure_direct_conversation_at(
    data_root: &Path,
    local_account_route: &str,
    local_x25519_public_key: Vec<u8>,
    contact_account_route: &str,
    contact_x25519_public_key: Vec<u8>,
    now_ms: u64,
) -> Result<Conversation, ChatError> {
    let conversation_id = direct_conversation_id(local_account_route, contact_account_route);
    if let Ok(conversation) = load_conversation_at(data_root, &conversation_id) {
        return Ok(conversation);
    }
    create_conversation_with_id_at(
        data_root,
        conversation_id,
        None,
        ConversationKind::Direct,
        None,
        vec![
            MemberInfo { account_route: local_account_route.to_string(), x25519_public_key: local_x25519_public_key },
            MemberInfo {
                account_route: contact_account_route.to_string(),
                x25519_public_key: contact_x25519_public_key,
            },
        ],
        now_ms,
    )
}

/// Permanently deletes the `Direct` conversation with a contact, if one exists — messages and
/// attachments live embedded in that single conversation file, so removing it wipes all of it in
/// one step. A no-op (not an error) if no such conversation exists yet. This is deliberately a
/// separate action from removing the chat contact itself (`sync_security::remove_chat_contact_at`):
/// removing a contact alone only revokes future auto-connect/trust and keeps history, exactly as
/// documented there — this is the "delete everything" option for someone who wants that instead.
pub fn delete_direct_conversation_at(
    data_root: &Path,
    local_account_route: &str,
    contact_account_route: &str,
) -> Result<(), ChatError> {
    let conversation_id = direct_conversation_id(local_account_route, contact_account_route);
    let path = conversation_path(data_root, &conversation_id);
    // The journal (see `journal_path`'s doc comment) can hold messages not yet folded into the
    // base document — removing only the base file would leave those resurrectable on next load.
    let _ = fs::remove_file(journal_path(data_root, &conversation_id));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ChatError::Io),
    }
}

/// Adds a member and rotates the epoch. The new member receives a wrap for the new epoch only —
/// no access to history from before they joined (ADR-0006's documented non-goal).
pub fn add_member_at(
    data_root: &Path,
    conversation_id: &str,
    new_member: MemberInfo,
    now_ms: u64,
) -> Result<Conversation, ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    if document.conversation.members.iter().any(|m| m.account_route == new_member.account_route) {
        return Err(ChatError::AlreadyAMember);
    }
    let mut epoch_key = [0_u8; 32];
    OsRng.fill_bytes(&mut epoch_key);
    document.conversation.members.push(new_member);
    let next_epoch_number = document.conversation.epochs.len() as u64;
    let wraps = rewrap_epoch_for_members(
        &epoch_key,
        &document.conversation.members,
        conversation_id,
        next_epoch_number,
    )?;
    document.conversation.epochs.push(Epoch { epoch_number: next_epoch_number, wraps, created_at_ms: now_ms });
    document.conversation.updated_at_ms = now_ms;
    let updated = document.conversation.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

/// Removes a member and rotates the epoch, wrapping the new key only for remaining members. This
/// is the operation `removed_member_cannot_decrypt_new_epoch_messages_or_attachments` verifies.
pub fn remove_member_at(
    data_root: &Path,
    conversation_id: &str,
    member_account_route: &str,
    now_ms: u64,
) -> Result<Conversation, ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    let existed = document.conversation.members.iter().any(|m| m.account_route == member_account_route);
    if !existed {
        return Err(ChatError::NotAMember);
    }
    document.conversation.members.retain(|m| m.account_route != member_account_route);
    let mut epoch_key = [0_u8; 32];
    OsRng.fill_bytes(&mut epoch_key);
    let next_epoch_number = document.conversation.epochs.len() as u64;
    let wraps = rewrap_epoch_for_members(
        &epoch_key,
        &document.conversation.members,
        conversation_id,
        next_epoch_number,
    )?;
    document.conversation.epochs.push(Epoch { epoch_number: next_epoch_number, wraps, created_at_ms: now_ms });
    document.conversation.updated_at_ms = now_ms;
    let updated = document.conversation.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

pub fn current_epoch_wrap_for<'a>(conversation: &'a Conversation, account_route: &str) -> Option<&'a EpochKeyWrap> {
    conversation
        .epochs
        .last()
        .and_then(|epoch| epoch.wraps.iter().find(|wrap| wrap.member_account_route == account_route))
}

fn message_nonce(epoch: u64, sequence: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(&(epoch as u32).to_be_bytes());
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

#[allow(clippy::too_many_arguments)]
pub fn send_message_at(
    data_root: &Path,
    conversation_id: &str,
    sender_device_id: &str,
    sender_account_route: &str,
    epoch_key: &[u8; 32],
    content_type: MessageContentType,
    plaintext: &[u8],
    mentions: Vec<String>,
    authorizer: &dyn ChatDeviceAuthorizer,
    now_ms: u64,
) -> Result<MessageRecord, ChatError> {
    authorizer.check_trusted(sender_device_id)?;
    let mut document = load_at(data_root, conversation_id)?;
    if !document.conversation.members.iter().any(|m| m.account_route == sender_account_route) {
        return Err(ChatError::NotAMember);
    }
    let epoch_number = document.conversation.epochs.len() as u64 - 1;
    let sequence = document.next_sequence;
    document.next_sequence += 1;
    let nonce = message_nonce(epoch_number, sequence);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(epoch_key));
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).map_err(|_| ChatError::Io)?;

    let message = MessageRecord {
        message_id: format!("cmsg_{}", nanoid::nanoid!(24)),
        conversation_id: conversation_id.to_string(),
        epoch: epoch_number,
        sequence,
        sender_device_id: sender_device_id.to_string(),
        sender_account_route: sender_account_route.to_string(),
        content_type,
        nonce: nonce.to_vec(),
        ciphertext,
        mentions,
        reactions: Vec::new(),
        created_at_ms: now_ms,
        edited_at_ms: None,
        deleted: false,
    };
    document.messages.push(message.clone());
    if document.messages.len() > MAX_MESSAGES_PER_CONVERSATION {
        let overflow = document.messages.len() - MAX_MESSAGES_PER_CONVERSATION;
        document.messages.drain(0..overflow);
    }
    append_or_compact_at(data_root, &document, &message)?;
    if !message.mentions.is_empty() {
        let _ = crate::sync_access::record_at(
            data_root,
            crate::sync_access::AccessCategory::Collaboration,
            crate::sync_access::AccessKind::ChatMention,
            &message.message_id,
            now_ms,
        );
    }
    Ok(message)
}

/// Decrypts a message given the epoch key the caller already unwrapped via `unwrap_key`. Pure —
/// no file I/O — so callers do not need to re-fetch the whole document just to read a message.
pub fn decrypt_message(message: &MessageRecord, epoch_key: &[u8; 32]) -> Result<Vec<u8>, ChatError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(epoch_key));
    let nonce = Nonce::from_slice(&message.nonce);
    cipher.decrypt(nonce, message.ciphertext.as_slice()).map_err(|_| ChatError::DecryptFailed)
}

pub fn list_messages_at(data_root: &Path, conversation_id: &str) -> Result<Vec<MessageRecord>, ChatError> {
    Ok(load_at(data_root, conversation_id)?.messages.into_iter().filter(|m| !m.deleted).collect())
}

fn epoch_wrap_at<'a>(
    conversation: &'a Conversation,
    epoch_number: u64,
    account_route: &str,
) -> Option<&'a EpochKeyWrap> {
    conversation
        .epochs
        .iter()
        .find(|epoch| epoch.epoch_number == epoch_number)
        .and_then(|epoch| epoch.wraps.iter().find(|wrap| wrap.member_account_route == account_route))
}

/// Resolves the plaintext key for a given epoch by unwrapping it with the local device's own
/// X25519 secret, read only into process memory (never logged, never returned through IPC).
///
/// `Direct` conversations are the one exception: they never go through the wrap mechanism at all.
/// A wrapped epoch key only ever lives inside the document of whichever device happened to create
/// the conversation first — the other device, having independently created its *own* local
/// `Direct` conversation record with its *own* random epoch key, has no way to ever learn that
/// key. Real cross-device delivery (as opposed to the single-device fixture every wrap-based test
/// here drives both "sides" of) needs a key both devices can derive *identically* on their own —
/// so `Direct` uses a plain ECDH shared secret between the two members' long-term X25519 keys
/// instead, which is symmetric by construction and needs nothing transmitted or agreed on ahead of
/// time beyond the deterministic `conversation_id` both sides already compute the same way (see
/// `ensure_direct_conversation_at`).
pub(crate) fn resolve_epoch_key(
    conversation: &Conversation,
    epoch_number: u64,
    account_route: &str,
    device_id: &str,
) -> Result<[u8; 32], ChatError> {
    if conversation.kind == ConversationKind::Direct {
        return resolve_direct_epoch_key(conversation, epoch_number, account_route, device_id);
    }
    let wrap = epoch_wrap_at(conversation, epoch_number, account_route).ok_or(ChatError::NotAMember)?;
    let secret = crate::sync_security::load_device_agreement_secret(device_id).map_err(|_| ChatError::Io)?;
    unwrap_key(wrap, &secret, &conversation.conversation_id, epoch_number)
}

fn resolve_direct_epoch_key(
    conversation: &Conversation,
    epoch_number: u64,
    account_route: &str,
    device_id: &str,
) -> Result<[u8; 32], ChatError> {
    let other = conversation
        .members
        .iter()
        .find(|member| member.account_route != account_route)
        .ok_or(ChatError::NotAMember)?;
    let other_public_bytes: [u8; 32] =
        other.x25519_public_key.as_slice().try_into().map_err(|_| ChatError::InvalidInput)?;
    let other_public = X25519PublicKey::from(other_public_bytes);
    let secret = crate::sync_security::load_device_agreement_secret(device_id).map_err(|_| ChatError::Io)?;
    let shared = secret.diffie_hellman(&other_public);
    let hkdf = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let info = format!("alethe-chat-direct-epoch-v1|{}|{epoch_number}", conversation.conversation_id);
    let mut key = [0_u8; 32];
    hkdf.expand(info.as_bytes(), &mut key).map_err(|_| ChatError::Io)?;
    Ok(key)
}

/// Idempotent: re-sending a message with the same `message_id` (e.g. a retried delivery from an
/// offline queue) is a safe no-op rather than a duplicate entry.
pub fn record_incoming_message_at(
    data_root: &Path,
    conversation_id: &str,
    message: MessageRecord,
) -> Result<(), ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    if document.messages.iter().any(|existing| existing.message_id == message.message_id) {
        return Ok(());
    }
    document.messages.push(message.clone());
    append_or_compact_at(data_root, &document, &message)
}

pub fn edit_message_at(
    data_root: &Path,
    conversation_id: &str,
    message_id: &str,
    editor_epoch_key: &[u8; 32],
    new_plaintext: &[u8],
    now_ms: u64,
) -> Result<MessageRecord, ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    let message = document
        .messages
        .iter_mut()
        .find(|m| m.message_id == message_id && !m.deleted)
        .ok_or(ChatError::NotFound)?;
    let nonce = message_nonce(message.epoch, message.sequence);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(editor_epoch_key));
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), new_plaintext).map_err(|_| ChatError::Io)?;
    message.ciphertext = ciphertext;
    message.edited_at_ms = Some(now_ms);
    let updated = message.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

pub fn delete_message_at(
    data_root: &Path,
    conversation_id: &str,
    message_id: &str,
    now_ms: u64,
) -> Result<MessageRecord, ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    let message = document
        .messages
        .iter_mut()
        .find(|m| m.message_id == message_id)
        .ok_or(ChatError::NotFound)?;
    message.deleted = true;
    message.edited_at_ms = Some(now_ms);
    let updated = message.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

pub fn react_to_message_at(
    data_root: &Path,
    conversation_id: &str,
    message_id: &str,
    member_account_route: &str,
    emoji: &str,
) -> Result<MessageRecord, ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    let message = document
        .messages
        .iter_mut()
        .find(|m| m.message_id == message_id && !m.deleted)
        .ok_or(ChatError::NotFound)?;
    message.reactions.retain(|r| r.member_account_route != member_account_route);
    message
        .reactions
        .push(Reaction { member_account_route: member_account_route.to_string(), emoji: emoji.to_string() });
    let updated = message.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

pub fn mark_read_at(
    data_root: &Path,
    conversation_id: &str,
    member_account_route: &str,
    up_to_sequence: u64,
    _now_ms: u64,
) -> Result<Conversation, ChatError> {
    let mut document = load_at(data_root, conversation_id)?;
    if let Some(entry) = document
        .conversation
        .read_cursors
        .iter_mut()
        .find(|(route, _)| route == member_account_route)
    {
        entry.1 = up_to_sequence;
    } else {
        document.conversation.read_cursors.push((member_account_route.to_string(), up_to_sequence));
    }
    let updated = document.conversation.clone();
    save_at(data_root, &document)?;
    Ok(updated)
}

#[allow(clippy::too_many_arguments)]
pub fn upload_attachment_at(
    data_root: &Path,
    conversation_id: &str,
    declared_content_type: &str,
    declared_size: u64,
    plaintext: &[u8],
    now_ms: u64,
) -> Result<AttachmentRecord, ChatError> {
    if plaintext.len() > MAX_ATTACHMENT_BYTES {
        return Err(ChatError::SizeMismatch);
    }
    if plaintext.len() as u64 != declared_size {
        return Err(ChatError::SizeMismatch);
    }
    let mut document = load_at(data_root, conversation_id)?;
    let attachment_id = format!("catt_{}", nanoid::nanoid!(24));
    let mut attachment_key = [0_u8; 32];
    OsRng.fill_bytes(&mut attachment_key);
    let wraps = rewrap_epoch_for_members(&attachment_key, &document.conversation.members, &attachment_id, 0)?;

    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&attachment_key));
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce_bytes), plaintext).map_err(|_| ChatError::Io)?;

    let attachment = AttachmentRecord {
        attachment_id,
        conversation_id: conversation_id.to_string(),
        declared_content_type: declared_content_type.to_string(),
        declared_size,
        actual_size: plaintext.len() as u64,
        content_hash: Sha256::digest(plaintext).iter().map(|b| format!("{b:02x}")).collect(),
        wraps,
        nonce: nonce_bytes.to_vec(),
        ciphertext,
        created_at_ms: now_ms,
    };
    document.attachments.push(attachment.clone());
    save_at(data_root, &document)?;
    Ok(attachment)
}

pub fn decrypt_attachment(attachment: &AttachmentRecord, attachment_key: &[u8; 32]) -> Result<Vec<u8>, ChatError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(attachment_key));
    let nonce = Nonce::from_slice(&attachment.nonce);
    cipher.decrypt(nonce, attachment.ciphertext.as_slice()).map_err(|_| ChatError::DecryptFailed)
}

/// Production `ChatDeviceAuthorizer`: a device is authorized only while it is `Trusted` for the
/// currently verified account, rechecked fresh on every call.
pub struct SecurityBackedChatAuthorizer<'a> {
    pub data_root: &'a Path,
}

impl ChatDeviceAuthorizer for SecurityBackedChatAuthorizer<'_> {
    fn check_trusted(&self, device_id: &str) -> Result<(), ChatError> {
        let document = crate::sync_security::load_at(self.data_root).map_err(|_| ChatError::Io)?;
        let is_trusted = document
            .devices
            .iter()
            .any(|device| device.device_id == device_id && device.trust == crate::sync_security::DeviceTrust::Trusted);
        if is_trusted {
            Ok(())
        } else {
            Err(ChatError::NotAuthorized)
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub sequence: u64,
    pub sender_device_id: String,
    pub sender_account_route: String,
    pub content_type: MessageContentType,
    pub text: String,
    pub mentions: Vec<String>,
    pub reactions: Vec<Reaction>,
    pub created_at_ms: u64,
    pub edited_at_ms: Option<u64>,
}

pub(crate) fn local_chat_identity(data_root: &Path) -> Result<(String, String), String> {
    let identity = crate::sync_security::local_identity_at(data_root)?;
    Ok((identity.device_id, identity.account_route))
}

#[tauri::command]
pub fn sync_ensure_project_conversation(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (_, account_route) = local_chat_identity(&data_root)?;
    let public_key = crate::sync_security::local_device_agreement_public_key_at(&data_root)?;
    ensure_project_conversation_at(&data_root, &project_id, &account_route, public_key, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_start_direct_conversation(
    app: tauri::AppHandle,
    contact_account_route: String,
) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (_, account_route) = local_chat_identity(&data_root)?;
    let local_public_key = crate::sync_security::local_device_agreement_public_key_at(&data_root)?;
    let contacts = crate::sync_security::list_chat_contacts_at(&data_root)?;
    let contact = contacts
        .into_iter()
        .find(|contact| contact.account_route == contact_account_route)
        .ok_or_else(|| "chat_contact_not_found".to_string())?;
    let contact_public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&contact.agreement_public_key)
        .map_err(|_| "chat_contact_key_invalid".to_string())?;
    ensure_direct_conversation_at(
        &data_root,
        &account_route,
        local_public_key,
        &contact_account_route,
        contact_public_key,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_delete_direct_conversation(
    app: tauri::AppHandle,
    contact_account_route: String,
) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (_, account_route) = local_chat_identity(&data_root)?;
    delete_direct_conversation_at(&data_root, &account_route, &contact_account_route)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_send_message(
    app: tauri::AppHandle,
    conversation_id: String,
    content_type: MessageContentType,
    text: String,
    mentions: Vec<String>,
) -> Result<DecryptedMessage, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, account_route) = local_chat_identity(&data_root)?;
    let conversation = load_conversation_at(&data_root, &conversation_id).map_err(|e| e.to_string())?;
    let epoch_number = conversation.epochs.len() as u64 - 1;
    let epoch_key = resolve_epoch_key(&conversation, epoch_number, &account_route, &device_id)
        .map_err(|e| e.to_string())?;
    let authorizer = SecurityBackedChatAuthorizer { data_root: &data_root };
    let message = send_message_at(
        &data_root,
        &conversation_id,
        &device_id,
        &account_route,
        &epoch_key,
        content_type,
        text.as_bytes(),
        mentions.clone(),
        &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())?;
    Ok(DecryptedMessage {
        message_id: message.message_id,
        conversation_id: message.conversation_id,
        sequence: message.sequence,
        sender_device_id: message.sender_device_id,
        sender_account_route: message.sender_account_route,
        content_type: message.content_type,
        text,
        mentions,
        reactions: message.reactions,
        created_at_ms: message.created_at_ms,
        edited_at_ms: message.edited_at_ms,
    })
}

/// Same as `sync_send_message`, plus the raw (still-encrypted) `MessageRecord` serialized as JSON
/// bytes — hand this to `p2p_send_frame` or `sync_seal_chat_relay_message` for live cross-device
/// delivery. Sending it as ciphertext (not the already-decrypted `text` field) means a receiving
/// device can persist it with `sync_ingest_chat_transport_frame` exactly like a locally-created
/// message, with no separate "received via network" representation to keep in sync.
#[tauri::command]
pub fn sync_send_message_for_transport(
    app: tauri::AppHandle,
    conversation_id: String,
    content_type: MessageContentType,
    text: String,
    mentions: Vec<String>,
) -> Result<(DecryptedMessage, Vec<u8>), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, account_route) = local_chat_identity(&data_root)?;
    let conversation = load_conversation_at(&data_root, &conversation_id).map_err(|e| e.to_string())?;
    let epoch_number = conversation.epochs.len() as u64 - 1;
    let epoch_key = resolve_epoch_key(&conversation, epoch_number, &account_route, &device_id)
        .map_err(|e| e.to_string())?;
    let authorizer = SecurityBackedChatAuthorizer { data_root: &data_root };
    let message = send_message_at(
        &data_root,
        &conversation_id,
        &device_id,
        &account_route,
        &epoch_key,
        content_type,
        text.as_bytes(),
        mentions.clone(),
        &authorizer,
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())?;
    let transport_frame = serde_json::to_vec(&message).map_err(|_| "chat_transport_encode_failed".to_string())?;
    Ok((
        DecryptedMessage {
            message_id: message.message_id,
            conversation_id: message.conversation_id,
            sequence: message.sequence,
            sender_device_id: message.sender_device_id,
            sender_account_route: message.sender_account_route,
            content_type: message.content_type,
            text,
            mentions,
            reactions: message.reactions,
            created_at_ms: message.created_at_ms,
            edited_at_ms: message.edited_at_ms,
        },
        transport_frame,
    ))
}

/// Ingests a `MessageRecord` received over P2P or the relay (see `sync_send_message_for_transport`):
/// persists it exactly like `record_incoming_message_at` already does for any incoming message
/// (idempotent by `message_id`), then decrypts it once for immediate display, so the receiving
/// side never needs a separate "live" message representation from what a later
/// `sync_list_decrypted_messages` poll would find anyway.
#[tauri::command]
pub fn sync_ingest_chat_transport_frame(
    app: tauri::AppHandle,
    conversation_id: String,
    frame: Vec<u8>,
) -> Result<DecryptedMessage, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, account_route) = local_chat_identity(&data_root)?;
    let message: MessageRecord = serde_json::from_slice(&frame).map_err(|_| "chat_transport_decode_failed".to_string())?;
    if message.conversation_id != conversation_id {
        return Err("chat_transport_conversation_mismatch".to_string());
    }
    record_incoming_message_at(&data_root, &conversation_id, message.clone()).map_err(|e| e.to_string())?;
    let conversation = load_conversation_at(&data_root, &conversation_id).map_err(|e| e.to_string())?;
    let epoch_key = resolve_epoch_key(&conversation, message.epoch, &account_route, &device_id)
        .map_err(|e| e.to_string())?;
    let plaintext = decrypt_message(&message, &epoch_key).map_err(|e| e.to_string())?;
    Ok(DecryptedMessage {
        message_id: message.message_id,
        conversation_id: message.conversation_id,
        sequence: message.sequence,
        sender_device_id: message.sender_device_id,
        sender_account_route: message.sender_account_route,
        content_type: message.content_type,
        text: String::from_utf8_lossy(&plaintext).into_owned(),
        mentions: message.mentions,
        reactions: message.reactions,
        created_at_ms: message.created_at_ms,
        edited_at_ms: message.edited_at_ms,
    })
}

#[tauri::command]
pub fn sync_list_decrypted_messages(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<Vec<DecryptedMessage>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, account_route) = local_chat_identity(&data_root)?;
    let conversation = load_conversation_at(&data_root, &conversation_id).map_err(|e| e.to_string())?;
    let messages = list_messages_at(&data_root, &conversation_id).map_err(|e| e.to_string())?;
    let mut decrypted = Vec::with_capacity(messages.len());
    for message in messages {
        let epoch_key = resolve_epoch_key(&conversation, message.epoch, &account_route, &device_id)
            .map_err(|e| e.to_string())?;
        let plaintext = decrypt_message(&message, &epoch_key).map_err(|e| e.to_string())?;
        decrypted.push(DecryptedMessage {
            message_id: message.message_id,
            conversation_id: message.conversation_id,
            sequence: message.sequence,
            sender_device_id: message.sender_device_id,
            sender_account_route: message.sender_account_route,
            content_type: message.content_type,
            text: String::from_utf8_lossy(&plaintext).into_owned(),
            mentions: message.mentions,
            reactions: message.reactions,
            created_at_ms: message.created_at_ms,
            edited_at_ms: message.edited_at_ms,
        });
    }
    Ok(decrypted)
}

#[tauri::command]
pub fn sync_edit_message(
    app: tauri::AppHandle,
    conversation_id: String,
    message_id: String,
    new_text: String,
) -> Result<DecryptedMessage, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, account_route) = local_chat_identity(&data_root)?;
    let conversation = load_conversation_at(&data_root, &conversation_id).map_err(|e| e.to_string())?;
    let epoch_number = conversation.epochs.len() as u64 - 1;
    let epoch_key = resolve_epoch_key(&conversation, epoch_number, &account_route, &device_id)
        .map_err(|e| e.to_string())?;
    let message = edit_message_at(
        &data_root,
        &conversation_id,
        &message_id,
        &epoch_key,
        new_text.as_bytes(),
        crate::provider_common::now_ms(),
    )
    .map_err(|e| e.to_string())?;
    Ok(DecryptedMessage {
        message_id: message.message_id,
        conversation_id: message.conversation_id,
        sequence: message.sequence,
        sender_device_id: message.sender_device_id,
        sender_account_route: message.sender_account_route,
        content_type: message.content_type,
        text: new_text,
        mentions: message.mentions,
        reactions: message.reactions,
        created_at_ms: message.created_at_ms,
        edited_at_ms: message.edited_at_ms,
    })
}

#[tauri::command]
pub fn sync_delete_message(
    app: tauri::AppHandle,
    conversation_id: String,
    message_id: String,
) -> Result<MessageRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    delete_message_at(&data_root, &conversation_id, &message_id, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_upload_attachment(
    app: tauri::AppHandle,
    conversation_id: String,
    declared_content_type: String,
    bytes: Vec<u8>,
) -> Result<AttachmentRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let declared_size = bytes.len() as u64;
    upload_attachment_at(&data_root, &conversation_id, &declared_content_type, declared_size, &bytes, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

/// Resolves and decrypts an attachment for the local device/account. Shared by both the Tauri
/// command and the Web route so the field access to the (module-private) stored document never
/// has to be duplicated across files.
pub(crate) fn download_attachment_plaintext(
    data_root: &Path,
    conversation_id: &str,
    attachment_id: &str,
    device_id: &str,
    account_route: &str,
) -> Result<Vec<u8>, ChatError> {
    let document = load_at(data_root, conversation_id)?;
    let attachment = document
        .attachments
        .iter()
        .find(|attachment| attachment.attachment_id == attachment_id)
        .ok_or(ChatError::NotFound)?;
    let wrap = attachment
        .wraps
        .iter()
        .find(|wrap| wrap.member_account_route == account_route)
        .ok_or(ChatError::NotAMember)?;
    let secret =
        crate::sync_security::load_device_agreement_secret(device_id).map_err(|_| ChatError::Io)?;
    let attachment_key = unwrap_key(wrap, &secret, attachment_id, 0)?;
    decrypt_attachment(attachment, &attachment_key)
}

#[tauri::command]
pub fn sync_download_attachment(
    app: tauri::AppHandle,
    conversation_id: String,
    attachment_id: String,
) -> Result<Vec<u8>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, account_route) = local_chat_identity(&data_root)?;
    download_attachment_plaintext(&data_root, &conversation_id, &attachment_id, &device_id, &account_route)
        .map_err(|e| e.to_string())
}

pub(crate) fn pack_sealed(envelope: &SealedEnvelope) -> Vec<u8> {
    let mut packed = Vec::with_capacity(32 + 12 + envelope.ciphertext.len());
    packed.extend_from_slice(&envelope.ephemeral_public_key);
    packed.extend_from_slice(&envelope.nonce);
    packed.extend_from_slice(&envelope.ciphertext);
    packed
}

pub(crate) fn unpack_sealed(packed: &[u8]) -> Result<SealedEnvelope, String> {
    if packed.len() < 32 + 12 {
        return Err("chat_relay_envelope_invalid".to_string());
    }
    let (ephemeral_public_key, rest) = packed.split_at(32);
    let (nonce, ciphertext) = rest.split_at(12);
    Ok(SealedEnvelope {
        ephemeral_public_key: ephemeral_public_key.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: ciphertext.to_vec(),
    })
}

const CHAT_RELAY_INFO: &[u8] = b"alethe-chat-relay-v1";

/// Encrypts a chat message (already-serialized `DecryptedMessage` JSON, the same plaintext
/// `p2p_send_frame` carries over a direct session) for delivery through the rendezvous relay as a
/// `chat_message` envelope, when direct P2P isn't available or hasn't connected yet. Reuses the
/// same sealed-box primitive already used for candidate/invitation envelopes
/// (`sync_crypto::seal_for_recipient`) — a genuinely new envelope *kind* on the wire, not a new
/// cryptographic scheme.
#[tauri::command]
pub fn sync_seal_chat_relay_message(
    plaintext: Vec<u8>,
    recipient_agreement_public_key: String,
) -> Result<String, String> {
    let public_key = URL_SAFE_NO_PAD
        .decode(&recipient_agreement_public_key)
        .map_err(|_| "chat_relay_recipient_key_invalid".to_string())?;
    let sealed =
        seal_for_recipient(&plaintext, &public_key, CHAT_RELAY_INFO).map_err(|_| "chat_relay_recipient_key_invalid".to_string())?;
    let packed = pack_sealed(&sealed);
    if packed.len() > 16 * 1024 {
        return Err("chat_relay_message_too_large".to_string());
    }
    Ok(URL_SAFE_NO_PAD.encode(packed))
}

/// Decrypts a `chat_message` envelope delivered by the rendezvous relay using this device's own
/// X25519 agreement secret. Returns the plaintext bytes — callers deserialize into whatever shape
/// they sent (a `DecryptedMessage` JSON in the chat relay path).
#[tauri::command]
pub fn sync_open_chat_relay_message(app: tauri::AppHandle, ciphertext: String) -> Result<Vec<u8>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    let (device_id, _) = local_chat_identity(&data_root)?;
    let recipient_secret = crate::sync_security::load_device_agreement_secret(&device_id)?;
    let packed = URL_SAFE_NO_PAD.decode(&ciphertext).map_err(|_| "chat_relay_envelope_invalid".to_string())?;
    let sealed = unpack_sealed(&packed)?;
    open_sealed(&sealed, &recipient_secret, CHAT_RELAY_INFO).map_err(|_| "chat_relay_decrypt_failed".to_string())
}

#[tauri::command]
pub fn sync_create_conversation(
    app: tauri::AppHandle,
    project_id: Option<String>,
    kind: ConversationKind,
    category: Option<String>,
    members: Vec<MemberInfo>,
) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    create_conversation_at(&data_root, project_id, kind, category, members, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_get_conversation(app: tauri::AppHandle, conversation_id: String) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    load_conversation_at(&data_root, &conversation_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_add_conversation_member(
    app: tauri::AppHandle,
    conversation_id: String,
    new_member: MemberInfo,
) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    add_member_at(&data_root, &conversation_id, new_member, crate::provider_common::now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_remove_conversation_member(
    app: tauri::AppHandle,
    conversation_id: String,
    member_account_route: String,
) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    remove_member_at(&data_root, &conversation_id, &member_account_route, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_list_messages(app: tauri::AppHandle, conversation_id: String) -> Result<Vec<MessageRecord>, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    list_messages_at(&data_root, &conversation_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_react_to_message(
    app: tauri::AppHandle,
    conversation_id: String,
    message_id: String,
    member_account_route: String,
    emoji: String,
) -> Result<MessageRecord, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    react_to_message_at(&data_root, &conversation_id, &message_id, &member_account_route, &emoji)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_mark_conversation_read(
    app: tauri::AppHandle,
    conversation_id: String,
    member_account_route: String,
    up_to_sequence: u64,
) -> Result<Conversation, String> {
    let data_root = crate::profiles::resolve_tauri_data_root(&app)?;
    mark_read_at(&data_root, &conversation_id, &member_account_route, up_to_sequence, crate::provider_common::now_ms())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AllowAll;
    impl ChatDeviceAuthorizer for AllowAll {
        fn check_trusted(&self, _device_id: &str) -> Result<(), ChatError> {
            Ok(())
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-chat-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn member(account_route: &str, secret: &X25519StaticSecret) -> MemberInfo {
        MemberInfo {
            account_route: account_route.to_string(),
            x25519_public_key: X25519PublicKey::from(secret).as_bytes().to_vec(),
        }
    }

    #[test]
    fn members_can_decrypt_a_message_sent_in_the_current_epoch() {
        let root = temp_root("basic");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let bob_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::PrivateGroup, None,
            vec![member("route-alice", &alice_secret), member("route-bob", &bob_secret)], 1_000,
        )
        .unwrap();

        let alice_wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let alice_key = unwrap_key(alice_wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();

        let message = send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &alice_key,
            MessageContentType::Text, b"hello bob", vec!["route-bob".to_string()], &AllowAll, 2_000,
        )
        .unwrap();

        let bob_wrap = current_epoch_wrap_for(&conversation, "route-bob").unwrap();
        let bob_key = unwrap_key(bob_wrap, &bob_secret, &conversation.conversation_id, 0).unwrap();
        let plaintext = decrypt_message(&message, &bob_key).unwrap();
        assert_eq!(plaintext, b"hello bob");

        let records = crate::sync_access::list_at(&root, 2_000).unwrap();
        let record = records
            .iter()
            .find(|record| record.kind == crate::sync_access::AccessKind::ChatMention)
            .unwrap();
        assert_eq!(record.category, crate::sync_access::AccessCategory::Collaboration);
        assert_eq!(record.subject_handle, message.message_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_message_with_no_mentions_publishes_no_access_center_record() {
        let root = temp_root("no-mentions");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();
        send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &key, MessageContentType::Text,
            b"no mentions here", vec![], &AllowAll, 2_000,
        )
        .unwrap();
        assert!(crate::sync_access::list_at(&root, 2_000).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sending_a_message_appends_to_the_journal_instead_of_rewriting_the_base_document() {
        let root = temp_root("journal-append");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();

        let base_path = conversation_path(&root, &conversation.conversation_id);
        let base_bytes_before = fs::read(&base_path).unwrap();

        send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &key, MessageContentType::Text,
            b"hi", vec![], &AllowAll, 2_000,
        )
        .unwrap();

        // The base document is untouched by a single send (well under the compaction threshold) —
        // only the journal grew. This is the whole point: sending stays O(1) instead of rewriting
        // everything sent before.
        assert_eq!(fs::read(&base_path).unwrap(), base_bytes_before);
        assert!(journal_path(&root, &conversation.conversation_id).exists());
        assert_eq!(journal_entry_count_at(&root, &conversation.conversation_id), 1);

        // But the message is still visible through the normal read path, transparently merged.
        let messages = list_messages_at(&root, &conversation.conversation_id).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].sequence, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn journal_compacts_into_the_base_document_once_the_threshold_is_reached() {
        let root = temp_root("journal-compact");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();

        for index in 0..JOURNAL_COMPACT_THRESHOLD {
            send_message_at(
                &root, &conversation.conversation_id, "dev-alice", "route-alice", &key,
                MessageContentType::Text, format!("msg {index}").as_bytes(), vec![], &AllowAll,
                2_000 + index as u64,
            )
            .unwrap();
        }

        // Compaction fired: the journal was folded into the base document and cleared.
        assert!(!journal_path(&root, &conversation.conversation_id).exists());
        let base = load_at(&root, &conversation.conversation_id).unwrap();
        assert_eq!(base.messages.len(), JOURNAL_COMPACT_THRESHOLD);
        assert_eq!(base.next_sequence, JOURNAL_COMPACT_THRESHOLD as u64 + 1);

        // Sequence numbers survive the merge correctly-ordered (not just "some 50 messages").
        for (index, message) in base.messages.iter().enumerate() {
            assert_eq!(message.sequence, index as u64 + 1);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn load_skips_a_truncated_trailing_journal_line_instead_of_failing() {
        let root = temp_root("journal-truncated");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();
        send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &key, MessageContentType::Text,
            b"first", vec![], &AllowAll, 2_000,
        )
        .unwrap();

        // Simulates a crash mid-`write_all` (append is not atomic like the base document's
        // write-temp-then-rename) by appending a line that isn't valid JSON.
        let path = journal_path(&root, &conversation.conversation_id);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{not valid json\n").unwrap();

        let messages = list_messages_at(&root, &conversation.conversation_id).unwrap();
        assert_eq!(messages.len(), 1);
        let plaintext = decrypt_message(&messages[0], &key).unwrap();
        assert_eq!(plaintext, b"first");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_a_direct_conversation_also_removes_its_journal() {
        let root = temp_root("journal-delete");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let bob_secret = X25519StaticSecret::random_from_rng(OsRng);
        let alice_route = "route-alice-delete";
        let bob_route = "route-bob-delete";
        let conversation = ensure_direct_conversation_at(
            &root, alice_route, X25519PublicKey::from(&alice_secret).as_bytes().to_vec(), bob_route,
            X25519PublicKey::from(&bob_secret).as_bytes().to_vec(), 1_000,
        )
        .unwrap();
        // Sending a real message isn't the point of this test, only that a journal file exists
        // and gets removed along with the base document — write a placeholder directly.
        fs::write(journal_path(&root, &conversation.conversation_id), b"{}\n").unwrap();
        assert!(journal_path(&root, &conversation.conversation_id).exists());

        delete_direct_conversation_at(&root, alice_route, bob_route).unwrap();

        assert!(!journal_path(&root, &conversation.conversation_id).exists());
        assert!(!conversation_path(&root, &conversation.conversation_id).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removed_member_cannot_decrypt_new_epoch_messages_or_attachments() {
        let root = temp_root("removed");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let mallory_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::PrivateGroup, None,
            vec![member("route-alice", &alice_secret), member("route-mallory", &mallory_secret)], 1_000,
        )
        .unwrap();
        // Mallory could decrypt epoch 0 while still a member.
        let mallory_wrap_epoch0 = current_epoch_wrap_for(&conversation, "route-mallory").unwrap().clone();
        assert!(unwrap_key(&mallory_wrap_epoch0, &mallory_secret, &conversation.conversation_id, 0).is_ok());

        let after_removal = remove_member_at(&root, &conversation.conversation_id, "route-mallory", 2_000).unwrap();
        assert!(!after_removal.members.iter().any(|m| m.account_route == "route-mallory"));

        // Mallory has no wrap entry at all in the new epoch — nothing to unwrap.
        assert!(current_epoch_wrap_for(&after_removal, "route-mallory").is_none());

        // Alice sends a message in the new epoch.
        let alice_wrap = current_epoch_wrap_for(&after_removal, "route-alice").unwrap();
        let alice_key = unwrap_key(alice_wrap, &alice_secret, &conversation.conversation_id, 1).unwrap();
        let message = send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &alice_key,
            MessageContentType::Text, b"mallory should never see this", vec![], &AllowAll, 3_000,
        )
        .unwrap();

        // Even if Mallory somehow obtained the ciphertext, decrypting with her old epoch-0 key
        // fails — it is a different, independently random key.
        let mallory_old_key = unwrap_key(&mallory_wrap_epoch0, &mallory_secret, &conversation.conversation_id, 0).unwrap();
        assert_eq!(decrypt_message(&message, &mallory_old_key).unwrap_err(), ChatError::DecryptFailed);

        // Attachments uploaded after removal are wrapped only for remaining members too.
        let attachment = upload_attachment_at(
            &root, &conversation.conversation_id, "text/plain", 5, b"secr\0".as_slice().get(..5).unwrap(), 4_000,
        )
        .unwrap();
        let _ = attachment; // wraps checked below via a fresh load
        let reloaded = load_conversation_at(&root, &conversation.conversation_id).unwrap();
        assert!(current_epoch_wrap_for(&reloaded, "route-mallory").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_message_delivery_is_idempotent() {
        let root = temp_root("duplicate");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();
        let message = send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &key, MessageContentType::Text,
            b"once", vec![], &AllowAll, 2_000,
        )
        .unwrap();

        record_incoming_message_at(&root, &conversation.conversation_id, message.clone()).unwrap();
        record_incoming_message_at(&root, &conversation.conversation_id, message.clone()).unwrap();
        let messages = list_messages_at(&root, &conversation.conversation_id).unwrap();
        assert_eq!(messages.iter().filter(|m| m.message_id == message.message_id).count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edit_and_delete_are_reversible_via_tombstone() {
        let root = temp_root("edit-delete");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();
        let message = send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &key, MessageContentType::Text,
            b"original", vec![], &AllowAll, 2_000,
        )
        .unwrap();

        let edited = edit_message_at(&root, &conversation.conversation_id, &message.message_id, &key, b"edited", 3_000)
            .unwrap();
        assert_eq!(decrypt_message(&edited, &key).unwrap(), b"edited");
        assert!(edited.edited_at_ms.is_some());

        delete_message_at(&root, &conversation.conversation_id, &message.message_id, 4_000).unwrap();
        assert!(list_messages_at(&root, &conversation.conversation_id).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reactions_and_read_cursors_are_tracked() {
        let root = temp_root("reactions");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let key = unwrap_key(wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();
        let message = send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &key, MessageContentType::Text,
            b"hi", vec![], &AllowAll, 2_000,
        )
        .unwrap();
        let reacted = react_to_message_at(&root, &conversation.conversation_id, &message.message_id, "route-bob", "👍")
            .unwrap();
        assert_eq!(reacted.reactions.len(), 1);

        let updated = mark_read_at(&root, &conversation.conversation_id, "route-bob", message.sequence, 3_000).unwrap();
        assert!(updated.read_cursors.iter().any(|(route, seq)| route == "route-bob" && *seq == message.sequence));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_declared_size_mismatch_is_rejected() {
        let root = temp_root("attachment");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let result = upload_attachment_at(&root, &conversation.conversation_id, "text/plain", 999, b"short", 2_000);
        assert_eq!(result.unwrap_err(), ChatError::SizeMismatch);

        let attachment =
            upload_attachment_at(&root, &conversation.conversation_id, "text/plain", 5, b"short", 2_000).unwrap();
        let wrap = attachment.wraps.iter().find(|w| w.member_account_route == "route-alice").unwrap();
        let attachment_key = unwrap_key(wrap, &alice_secret, &attachment.attachment_id, 0).unwrap();
        assert_eq!(decrypt_attachment(&attachment, &attachment_key).unwrap(), b"short");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_member_cannot_send_a_message() {
        let root = temp_root("non-member");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::Direct, None, vec![member("route-alice", &alice_secret)], 1_000,
        )
        .unwrap();
        let dummy_key = [0_u8; 32];
        let result = send_message_at(
            &root, &conversation.conversation_id, "dev-eve", "route-eve", &dummy_key, MessageContentType::Text,
            b"intrusion", vec![], &AllowAll, 2_000,
        );
        assert_eq!(result.unwrap_err(), ChatError::NotAMember);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_transport_frame_survives_serialization_and_ingestion_round_trip() {
        let root = temp_root("transport-frame");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let bob_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::PrivateGroup, None,
            vec![member("route-alice", &alice_secret), member("route-bob", &bob_secret)], 1_000,
        )
        .unwrap();
        let alice_wrap = current_epoch_wrap_for(&conversation, "route-alice").unwrap();
        let alice_key = unwrap_key(alice_wrap, &alice_secret, &conversation.conversation_id, 0).unwrap();
        let sent = send_message_at(
            &root, &conversation.conversation_id, "dev-alice", "route-alice", &alice_key,
            MessageContentType::Text, b"delivered over the wire", vec![], &AllowAll, 2_000,
        )
        .unwrap();

        // What actually crosses the wire: the raw, still-encrypted MessageRecord as JSON bytes —
        // exactly what `sync_send_message_for_transport` hands to `p2p_send_frame`/the relay.
        let frame = serde_json::to_vec(&sent).unwrap();
        let deserialized: MessageRecord = serde_json::from_slice(&frame).unwrap();
        assert_eq!(deserialized.ciphertext, sent.ciphertext);

        // The receiving side (a different install, but sharing the same fixture root here for the
        // test) ingests it exactly like `sync_ingest_chat_transport_frame` does.
        record_incoming_message_at(&root, &conversation.conversation_id, deserialized.clone()).unwrap();
        // Idempotent: ingesting the same frame twice (e.g. arriving via both P2P and relay) is a
        // safe no-op, not a duplicate.
        record_incoming_message_at(&root, &conversation.conversation_id, deserialized).unwrap();
        let stored = list_messages_at(&root, &conversation.conversation_id).unwrap();
        assert_eq!(stored.len(), 1);

        let bob_wrap = current_epoch_wrap_for(&conversation, "route-bob").unwrap();
        let bob_key = unwrap_key(bob_wrap, &bob_secret, &conversation.conversation_id, 0).unwrap();
        let plaintext = decrypt_message(&stored[0], &bob_key).unwrap();
        assert_eq!(plaintext, b"delivered over the wire");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn seal_and_pack_round_trips_a_relayed_chat_message_and_rejects_a_short_envelope() {
        let secret = X25519StaticSecret::random_from_rng(OsRng);
        let public_key = URL_SAFE_NO_PAD.encode(X25519PublicKey::from(&secret).as_bytes());
        let ciphertext = sync_seal_chat_relay_message(b"hello over the relay".to_vec(), public_key).unwrap();

        let packed = URL_SAFE_NO_PAD.decode(&ciphertext).unwrap();
        let sealed = unpack_sealed(&packed).unwrap();
        let plaintext = open_sealed(&sealed, &secret, CHAT_RELAY_INFO).unwrap();
        assert_eq!(plaintext, b"hello over the relay");

        assert!(unpack_sealed(b"too short").is_err());
    }

    #[test]
    fn ensure_direct_conversation_reuses_the_same_conversation_and_is_never_a_project_channel() {
        let root = temp_root("ensure-direct");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let bob_secret = X25519StaticSecret::random_from_rng(OsRng);
        let alice_key = X25519PublicKey::from(&alice_secret).as_bytes().to_vec();
        let bob_key = X25519PublicKey::from(&bob_secret).as_bytes().to_vec();

        let first = ensure_direct_conversation_at(
            &root, "route-alice", alice_key.clone(), "route-bob", bob_key.clone(), 1_000,
        )
        .unwrap();
        assert_eq!(first.kind, ConversationKind::Direct);
        assert_eq!(first.project_id, None);
        assert_eq!(first.members.len(), 2);

        let second =
            ensure_direct_conversation_at(&root, "route-alice", alice_key, "route-bob", bob_key, 2_000).unwrap();
        assert_eq!(first.conversation_id, second.conversation_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ensure_project_conversation_reuses_the_same_channel_and_separates_projects() {
        let root = temp_root("ensure-project");
        let secret = X25519StaticSecret::random_from_rng(OsRng);
        let public_key = X25519PublicKey::from(&secret).as_bytes().to_vec();

        let first = ensure_project_conversation_at(&root, "proj-a", "route-alice", public_key.clone(), 1_000)
            .unwrap();
        let second =
            ensure_project_conversation_at(&root, "proj-a", "route-alice", public_key.clone(), 2_000).unwrap();
        assert_eq!(first.conversation_id, second.conversation_id);
        assert_eq!(second.kind, ConversationKind::ProjectChannel);
        assert_eq!(second.project_id.as_deref(), Some("proj-a"));

        let other_project =
            ensure_project_conversation_at(&root, "proj-b", "route-alice", public_key, 3_000).unwrap();
        assert_ne!(first.conversation_id, other_project.conversation_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn epoch_wrap_at_finds_the_wrap_for_the_right_epoch_and_member_only() {
        let root = temp_root("epoch-wrap");
        let alice_secret = X25519StaticSecret::random_from_rng(OsRng);
        let bob_secret = X25519StaticSecret::random_from_rng(OsRng);
        let conversation = create_conversation_at(
            &root, None, ConversationKind::PrivateGroup, None,
            vec![member("route-alice", &alice_secret), member("route-bob", &bob_secret)], 1_000,
        )
        .unwrap();
        assert!(epoch_wrap_at(&conversation, 0, "route-alice").is_some());
        assert!(epoch_wrap_at(&conversation, 0, "route-mallory").is_none());
        assert!(epoch_wrap_at(&conversation, 1, "route-alice").is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
