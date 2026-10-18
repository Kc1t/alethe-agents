import SwiftUI

struct SettingsSearchEntry: Identifiable {
    let category: String
    let target: String
    let label: String
    let detail: String
    let keywords: String
    var id: String { category + "." + label }
    func matches(_ query: String) -> Bool {
        (String(localized: String.LocalizationValue(label)) + " "
            + String(localized: String.LocalizationValue(detail)) + " " + keywords)
            .localizedCaseInsensitiveContains(query.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static let all: [Self] = [
        .init(category: "account", target: "account.0", label: "settings.web.reference.prefs.profile", detail: "settings.web.reference.prefs.profileDesc", keywords: "avatar photo name nome perfil account conta 头像 照片 名称 账户 账号"),
        .init(category: "account", target: "account.1", label: "settings.web.reference.prefs.language", detail: "settings.web.reference.prefs.languageDesc", keywords: "language idioma português english 语言 中文 chinese zh"),
        .init(category: "account", target: "account.2", label: "settings.web.reference.prefs.localAccounts", detail: "settings.web.reference.prefs.localAccountsDesc", keywords: "account profile conta perfil local switch trocar 账户 账号 个人资料 切换"),
        .init(category: "appearance", target: "appearance.2", label: "settings.web.reference.prefs.uiTheme", detail: "settings.web.reference.prefs.uiThemeDesc", keywords: "theme tema colors cores light dark claro escuro 主题 颜色 浅色 深色"),
        .init(category: "remote", target: "", label: "settings.web.reference.remote.settingsStatusTitle", detail: "settings.web.reference.remote.settingsStatusDesc", keywords: "remote control lan security qr device mobile celular segurança pareamento"),
        .init(category: "organization", target: "organization.0", label: "settings.web.reference.prefs.categoryOrganization", detail: "settings.web.reference.prefs.categoryOrganizationDesc", keywords: "archive archived groups grupo arquivado restaurar restore"),
        .init(category: "appearance", target: "appearance.5", label: "settings.web.reference.prefs.uiZoom", detail: "settings.web.reference.prefs.uiZoomDesc", keywords: "zoom scale escala tamanho interface"),
        .init(category: "appearance", target: "appearance.8", label: "settings.web.reference.prefs.windowOpacity", detail: "settings.web.reference.prefs.windowOpacityDesc", keywords: "opacity opacidade transparency transparência desktop window janela"),
        .init(category: "appearance", target: "appearance.6", label: "settings.web.reference.prefs.topbarStyle", detail: "settings.web.reference.prefs.topbarStyleDesc", keywords: "topbar barra superior layout areas tabs sidebar"),
        .init(category: "appearance", target: "appearance.7", label: "settings.web.reference.prefs.viewPlacement", detail: "settings.web.reference.prefs.viewPlacementDesc", keywords: "git source control plugin view sidebar esquerda direita left right"),
        .init(category: "features", target: "", label: "settings.web.reference.prefs.features", detail: "settings.web.reference.prefs.featuresDesc", keywords: "features recursos modules módulos todo task tarefa git source control sidebar 功能 模块 待办"),
        .init(category: "plugins", target: "", label: "settings.web.reference.prefs.pluginsInstalledTitle", detail: "settings.web.reference.prefs.pluginsInstalledDesc", keywords: "plugin plugins extension extensao extensão addon bundled integrado local enable disable ativar desativar capability capabilities permissao permissão theme tema pane painel sidebar command comando"),
        .init(category: "plugins", target: "", label: "settings.web.reference.prefs.pluginsInstallTitle", detail: "settings.web.reference.prefs.pluginsInstallDesc", keywords: "plugin install instalar manifest manifesto json folder pasta uninstall desinstalar trust confiar"),
        .init(category: "appearance", target: "appearance.4", label: "settings.web.reference.prefs.terminalTheme", detail: "settings.web.reference.prefs.terminalThemeDesc", keywords: "terminal theme tema colors cores"),
        .init(category: "terminal", target: "terminal.0", label: "settings.web.reference.prefs.resourcePolicy", detail: "settings.web.reference.prefs.resourcePolicyDesc", keywords: "memory ram performance budget limit lru suspend memória desempenho limite"),
        .init(category: "orchestration", target: "orchestration.2", label: "settings.web.reference.prefs.orchestrationRoles", detail: "settings.web.reference.prefs.orchestrationRolesDesc", keywords: "orchestration orquestração role papel model modelo effort esforço reviewer revisor read-only"),
        .init(category: "orchestration", target: "orchestration.1", label: "settings.web.reference.prefs.orchestrationLimits", detail: "settings.web.reference.prefs.orchestrationLimitsDesc", keywords: "orchestration orquestração workers concurrency paralelo timeout budget orçamento"),
        .init(category: "orchestration", target: "orchestration.3", label: "settings.web.reference.prefs.orchestrationRouting", detail: "settings.web.reference.prefs.orchestrationRoutingDesc", keywords: "orchestration routing roteamento preset regras rules delegate economy balanced performance custom 路由 规则 预设"),
        .init(category: "orchestration", target: "orchestration.3", label: "settings.web.reference.prefs.routingCriticalThreshold", detail: "settings.web.reference.prefs.routingCriticalThresholdHint", keywords: "quota cota critical crítico threshold limite opus gate 配额 阈值 临界"),
        .init(category: "terminal", target: "terminal.1", label: "settings.web.reference.prefs.spawnConcurrency", detail: "settings.web.reference.prefs.spawnConcurrencyDesc", keywords: "spawn concurrency parallel paralelo fila queue performance pty"),
        .init(category: "terminal", target: "terminal.2", label: "settings.web.reference.prefs.agentsTitle", detail: "settings.web.reference.prefs.agentsDesc", keywords: "agents agentes claude codex opencode shell 智能体 代理 代理程序"),
        .init(category: "terminal", target: "terminal.7", label: "settings.web.reference.prefs.experimentalPermissions", detail: "settings.web.reference.prefs.experimentalPermissionsDesc", keywords: "permission permissions ask bypass approval canvas sandbox worker skip dangerously permissão permissões aprovação 权限 审批"),
        .init(category: "terminal", target: "terminal.8", label: "settings.web.reference.prefs.resetSession", detail: "settings.web.reference.prefs.resetSessionDesc", keywords: "reset session resume retomar resetar sessão última last recover recuperar resume crash boot"),
        .init(category: "integrations", target: "", label: "settings.web.reference.prefs.usageAccess", detail: "settings.web.reference.prefs.usageAccessDesc", keywords: "usage quota limits consent privacy credentials claude codex antigravity uso limite privacidade credenciais"),
        .init(category: "integrations", target: "", label: "settings.web.reference.prefs.cliCommand", detail: "settings.web.reference.prefs.cliCommandDesc", keywords: "cli command terminal path shell comando linha de comando abrir pasta"),
        .init(category: "integrations", target: "", label: "settings.web.reference.router9.title", detail: "settings.web.reference.router9.desc", keywords: "9router router proxy roteador rate limit fallback provider provedor base url api key chave anthropic openai"),
        .init(category: "integrations", target: "", label: "settings.web.reference.prefs.spotify", detail: "settings.web.reference.prefs.spotifyDesc", keywords: "spotify music música client id secret"),
        .init(category: "integrations", target: "", label: "settings.web.reference.prefs.discordPresence", detail: "settings.web.reference.prefs.discordPresenceHint", keywords: "discord rich presence status integração"),
        .init(category: "integrations", target: "", label: "settings.web.reference.prefs.dictation", detail: "settings.web.reference.prefs.dictationDesc", keywords: "dictation voice mic microphone ditado voz microfone speech parakeet stt"),
        .init(category: "about", target: "about.0", label: "settings.web.reference.prefs.aboutVersionTitle", detail: "settings.web.reference.prefs.aboutVersionDesc", keywords: "version versão about sobre build info app"),
        .init(category: "about", target: "about.1", label: "settings.web.reference.prefs.aboutUpdatesTitle", detail: "settings.web.reference.prefs.aboutUpdatesDesc", keywords: "update atualização atualizar upgrade nova versão release check 更新 升级 版本"),
    ]
}

private struct SettingsSearchTargetKey: EnvironmentKey {
    static let defaultValue = ""
}
extension EnvironmentValues {
    var settingsSearchTarget: String {
        get { self[SettingsSearchTargetKey.self] }
        set { self[SettingsSearchTargetKey.self] = newValue }
    }
}
