use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

use crate::git_control::hide_console;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub success: bool,
    pub stage: String,
    pub output: String,
}

#[tauri::command]
pub fn run_validation(cwd: String, commands: Vec<String>) -> Result<ValidationResult, String> {
    let path = Path::new(&cwd);
    if !path.exists() {
        return Err("directory_not_found".to_string());
    }

    for cmd_str in commands {
        let trimmed = cmd_str.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut command = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(&["/C", trimmed]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(&["-c", trimmed]);
            c
        };

        command.current_dir(path);
        hide_console(&mut command);

        match command.output() {
            Ok(output) => {
                if !output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    return Ok(ValidationResult {
                        success: false,
                        stage: trimmed.to_string(),
                        output: format!("Stdout:\n{}\nStderr:\n{}", stdout, stderr),
                    });
                }
            }
            Err(e) => {
                return Ok(ValidationResult {
                    success: false,
                    stage: trimmed.to_string(),
                    output: format!("Falha ao iniciar comando: {}", e),
                });
            }
        }
    }

    Ok(ValidationResult {
        success: true,
        stage: "All".to_string(),
        output: "Todas as validações passaram com sucesso!".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validation_pipeline_success() {
        let dir = std::env::current_dir().unwrap();
        let cmd = "echo hello";
        let res = run_validation(dir.to_string_lossy().to_string(), vec![cmd.to_string()]).unwrap();
        assert!(res.success);
        assert_eq!(res.stage, "All");
    }

    #[test]
    fn test_validation_pipeline_failure() {
        let dir = std::env::current_dir().unwrap();
        let cmd = if cfg!(windows) { "exit 1" } else { "exit 1" };
        let res = run_validation(dir.to_string_lossy().to_string(), vec![cmd.to_string()]).unwrap();
        assert!(!res.success);
        assert_eq!(res.stage, cmd);
    }
}
