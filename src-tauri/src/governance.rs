use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyResult {
    pub decision: Decision,
    pub reason: String,
}

/// The desktop shell must never be an ungoverned command execution bypass.
/// Agent-initiated writes/checks use their dedicated approval flow instead.
pub fn assess_terminal_command(command: &str) -> PolicyResult {
    let value = command.trim();
    if value.is_empty() || value.len() > 8_192 {
        return deny("命令必须包含 1 到 8192 个字符");
    }
    if value
        .chars()
        .any(|character| matches!(character, '\n' | '\r' | ';' | '|' | '&' | '>' | '<' | '`'))
    {
        return deny("直接终端不允许组合、重定向或管道命令");
    }
    if matches!(
        value,
        "git status" | "git status --short" | "git diff" | "git diff --check"
    ) {
        return allow("受限只读 Git 检查");
    }
    if matches!(value, "npm test" | "npm test -- --run" | "cargo test") {
        return approve("测试命令需要通过受控审批任务执行");
    }
    approve("任意 Shell 命令必须通过受控 Agent 的审批链路执行")
}

pub fn redact_audit_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut redact_next = false;
    for token in value.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        if redact_next
            || lower.contains("api_key=")
            || lower.contains("token=")
            || lower.contains("secret=")
            || lower.contains("password=")
        {
            result.push_str("[REDACTED]");
        } else {
            result.push_str(token);
        }
        redact_next = lower == "bearer" || lower.ends_with("bearer:");
        result.push(' ');
    }
    result.trim_end().to_string()
}

fn allow(reason: &str) -> PolicyResult {
    PolicyResult {
        decision: Decision::Allow,
        reason: reason.to_string(),
    }
}

fn approve(reason: &str) -> PolicyResult {
    PolicyResult {
        decision: Decision::Approve,
        reason: reason.to_string(),
    }
}

fn deny(reason: &str) -> PolicyResult {
    PolicyResult {
        decision: Decision::Deny,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_read_only_terminal_checks() {
        assert_eq!(
            assess_terminal_command("git status --short").decision,
            Decision::Allow
        );
        assert_eq!(
            assess_terminal_command("git status; rm -rf .").decision,
            Decision::Deny
        );
    }

    #[test]
    fn routes_non_read_only_commands_to_managed_approval() {
        assert_eq!(
            assess_terminal_command("npm test").decision,
            Decision::Approve
        );
        assert_eq!(
            assess_terminal_command("powershell -Command whoami").decision,
            Decision::Approve
        );
    }

    #[test]
    fn redacts_secret_like_audit_values() {
        assert_eq!(redact_audit_text("token=abc normal"), "[REDACTED] normal");
        assert_eq!(
            redact_audit_text("Authorization: Bearer abc normal"),
            "Authorization: Bearer [REDACTED] normal"
        );
    }
}
