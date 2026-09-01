// Fase 3 do agent canvas — "modo economia".
//

//

use std::fs;
use std::path::PathBuf;

const MARKER: &str = "gerado pelo Alethe (modo economia)";

const AGENTS: &[(&str, &str)] = &[
    (
        "haiku-resumidor.md",
        r#"---
name: haiku-resumidor
description: MUST BE USED para resumir arquivos, extrair informação específica, classificar conteúdo e varrer logs. Use proativamente sempre que precisar ler muito conteúdo e só o resumo ou um dado pontual importar.
model: haiku
tools: Read, Grep, Glob
---

Você é um worker de leitura barato. Sua única função é ler muito e devolver pouco.

Regras:
- Responda SEMPRE em formato curto e estruturado: bullets, no máximo ~150 palavras.
- Nunca cole trechos longos do conteúdo lido; extraia só o que foi pedido.
- Se a tarefa pedir um dado específico (número, nome, path), devolva só ele.
- Não tome decisões de arquitetura nem sugira refactors — só reporte fatos.

<!-- gerado pelo Alethe (modo economia) — seguro deletar -->
"#,
    ),
    (
        "haiku-mecanico.md",
        r#"---
name: haiku-mecanico
description: MUST BE USED para tarefas mecânicas de edição - gerar boilerplate, renomear símbolos, formatar, aplicar a mesma mudança repetitiva em vários arquivos. Use proativamente quando a tarefa for braçal, bem especificada e não exigir decisão de design.
model: haiku
tools: Read, Edit, Write, Grep, Glob
---

Você é um worker mecânico barato. Executa edições braçais exatamente como especificado.

Regras:
- Siga a especificação à risca; não "melhore" nada por conta própria.
- Em caso de ambiguidade, pare e devolva a dúvida em uma linha em vez de adivinhar.
- Resposta final: lista curta de arquivos tocados + uma linha do que mudou em cada.

<!-- gerado pelo Alethe (modo economia) — seguro deletar -->
"#,
    ),
    (
        // (validado na POC — ele roda find/grep por conta). O hook PreToolUse

        // `codex exec`, devolvendo o motivo pro modelo tentar de novo certo.
        "codex-only-guard.cjs",
        r#"                                                               
let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = JSON.parse(raw).tool_input.command || ''
  } catch {}
  if (!/^\s*codex\s+exec\b/.test(cmd)) {
    console.error('Bloqueado: o codex-executor só pode rodar `codex exec ...`. Monte a tarefa como instrução autocontida e delega pro codex.')
    process.exit(2)
  }
})
"#,
    ),
    (
        "codex-executor.md",
        r#"---
name: codex-executor
description: EXPERIMENTAL - use para execução longa e barulhenta onde só o resumo importa - rodar suites de teste, builds demorados, aplicar um fix mecânico e verificar. O trabalho pesado roda no Codex CLI (GPT), fora do orçamento de tokens do Claude.
model: haiku
tools: Bash
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: node .claude/agents/codex-only-guard.cjs
---

Você é um proxy pro Codex CLI. O ÚNICO comando Bash que você está autorizado a rodar é `codex exec`. Rodar qualquer outro comando (find, grep, cat, npm, cargo…) é uma violação — mesmo que a tarefa pareça trivial, ela DEVE ir pro codex.

Como operar:
1. Monte a tarefa como uma instrução autocontida em inglês (o codex não vê esta conversa).
2. Rode: `codex exec --skip-git-repo-check "<instrução>"`.
3. Devolva APENAS: resultado em até 5 bullets + o que falhou, se falhou. Nunca cole a saída bruta inteira.

<!-- gerado pelo Alethe (modo economia) — seguro deletar -->
"#,
    ),
];

fn agents_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join(".claude").join("agents")
}

#[tauri::command]
pub fn economy_agents_enabled(folder: String) -> bool {
    let dir = agents_dir(&folder);
    AGENTS.iter().all(|(name, _)| dir.join(name).is_file())
}

#[tauri::command]
pub fn set_economy_agents(folder: String, enabled: bool) -> Result<Vec<String>, String> {
    let dir = agents_dir(&folder);
    let mut touched = Vec::new();

    if enabled {
        fs::create_dir_all(&dir).map_err(|e| format!("criar {}: {e}", dir.display()))?;
        for (name, body) in AGENTS {
            let path = dir.join(name);
            fs::write(&path, body).map_err(|e| format!("escrever {}: {e}", path.display()))?;
            touched.push(path.to_string_lossy().to_string());
        }
        eprintln!(
            "[economy_agents] {} agents escritos em {}",
            AGENTS.len(),
            dir.display()
        );
    } else {
        for (name, _) in AGENTS {
            let path = dir.join(name);
            let ours = fs::read_to_string(&path)
                .map(|c| c.contains(MARKER))
                .unwrap_or(false);
            if ours {
                fs::remove_file(&path).map_err(|e| format!("remover {}: {e}", path.display()))?;
                touched.push(path.to_string_lossy().to_string());
            }
        }
        eprintln!(
            "[economy_agents] {} agents removidos de {}",
            touched.len(),
            dir.display()
        );
    }

    Ok(touched)
}
