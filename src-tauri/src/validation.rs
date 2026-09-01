use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

use crate::git_control::hide_console;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub success: bool,
    pub stage: String,
    pub output: String,
    /// `false` when `commands` was empty (or only blank lines) and no real
    /// command actually ran — distinguishes "validated and passed" from
    /// "nothing was configured to validate", which used to be indistinguishable
    /// (`success: true` in both cases), making the gate claim "passed" for
    /// projects that never ran anything real.
    #[serde(default)]
    pub ran_any_command: bool,
}

#[tauri::command]
pub fn run_validation(cwd: String, commands: Vec<String>) -> Result<ValidationResult, String> {
    let path = Path::new(&cwd);
    if !path.exists() {
        return Err("directory_not_found".to_string());
    }

    let mut ran_any_command = false;

    for cmd_str in commands {
        let trimmed = cmd_str.trim();
        if trimmed.is_empty() {
            continue;
        }
        ran_any_command = true;

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
                        ran_any_command,
                    });
                }
            }
            Err(e) => {
                return Ok(ValidationResult {
                    success: false,
                    stage: trimmed.to_string(),
                    output: format!("Failed to start command: {}", e),
                    ran_any_command,
                });
            }
        }
    }

    Ok(ValidationResult {
        success: true,
        stage: if ran_any_command {
            "All".to_string()
        } else {
            "None".to_string()
        },
        output: if ran_any_command {
            "All validations passed successfully!".to_string()
        } else {
            "No validation command configured — nothing was run.".to_string()
        },
        ran_any_command,
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
        assert!(res.ran_any_command);
    }

    #[test]
    fn test_validation_pipeline_empty_commands_is_unverified() {
        let dir = std::env::current_dir().unwrap();
        let res = run_validation(dir.to_string_lossy().to_string(), vec![]).unwrap();
        assert!(res.success);
        assert!(!res.ran_any_command);
        assert_eq!(res.stage, "None");

        let res_blank_only = run_validation(
            dir.to_string_lossy().to_string(),
            vec!["   ".to_string(), "".to_string()],
        )
        .unwrap();
        assert!(res_blank_only.success);
        assert!(!res_blank_only.ran_any_command);
        assert_eq!(res_blank_only.stage, "None");
    }
}
