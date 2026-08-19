// Bridge de sinal real de "working"/"idle" do OpenCode via plugin.
//
// A heuristica generica de PTY (agentCompletionMonitor.ts, frontend) nao funciona

// o "salto de texto novo apos Enter" que a heuristica espera raramente acontece

//
// Este modulo escreve um plugin real do OpenCode (formato confirmado em
// opencode.ai/docs/plugins/) num diretorio GLOBAL do usuario

// qualquer terminal opencode que o Alethe spawnar, nao so os com Graphify
// habilitado. O plugin reporta session.idle/tool.execute.before de volta pro
// Alethe via HTTP local, reaproveitando o listener ja existente em

use std::path::PathBuf;

const PLUGIN_FILE_NAME: &str = "alethe-bridge.js";

const PLUGIN_SOURCE: &str = r#"                                                                                
// boot do app se o conteudo mudar).
//
                                                                                
// via o endpoint local passado em ALETHE_BRIDGE_ENDPOINT (injetado como env var
                                                                          
// quebrar a sessao do OpenCode se o Alethe nao estiver rodando ou a porta tiver
// mudado.
export const AletheBridgePlugin = async ({ directory }) => {
  const endpoint = process.env.ALETHE_BRIDGE_ENDPOINT
  if (!endpoint) return {}

  const report = async (state) => {
    try {
      await fetch(`${endpoint}/opencode-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, state }),
      })
    } catch {
                                                                              
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") await report("idle")
    },
    "tool.execute.before": async () => {
      await report("working")
    },
  }
}
"#;

fn plugin_dir() -> Option<PathBuf> {
    Some(
        dirs_next::home_dir()?
            .join(".config")
            .join("opencode")
            .join("plugin"),
    )
}

pub fn ensure_installed() {
    let Some(dir) = plugin_dir() else {
        eprintln!("[opencode_bridge] não foi possível resolver o diretório home");
        return;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[opencode_bridge] falha ao criar {dir:?}: {e}");
        return;
    }
    let path = dir.join(PLUGIN_FILE_NAME);
    let needs_write = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != PLUGIN_SOURCE,
        Err(_) => true,
    };
    if !needs_write {
        return;
    }
    if let Err(e) = std::fs::write(&path, PLUGIN_SOURCE) {
        eprintln!("[opencode_bridge] falha ao escrever plugin em {path:?}: {e}");
    } else {
        eprintln!("[opencode_bridge] plugin instalado em {}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_source_exports_the_expected_hooks() {
        assert!(PLUGIN_SOURCE.contains("export const AletheBridgePlugin"));
        assert!(PLUGIN_SOURCE.contains("session.idle"));
        assert!(PLUGIN_SOURCE.contains("tool.execute.before"));
        assert!(PLUGIN_SOURCE.contains("ALETHE_BRIDGE_ENDPOINT"));
        assert!(PLUGIN_SOURCE.contains("/opencode-status"));
    }
}
