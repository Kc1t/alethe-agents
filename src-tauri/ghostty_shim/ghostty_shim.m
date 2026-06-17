// Implementação do shim. Objective-C (.m) porque os callbacks de clipboard
// usam NSPasteboard. Inclui o ghostty.h real do xcframework — a ABI das structs
// é resolvida pelo compilador, não reproduzida à mão no Rust.
#import "ghostty_shim.h"
#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>
#import "ghostty.h"

// App global do Ghostty (singleton, como no app oficial e no wrapper Swift).
static ghostty_app_t g_app = NULL;
static ghostty_config_t g_config = NULL;

// Registro simples de surfaces vivas, para redesenhá-las após cada tick (o
// terminal precisa de um draw quando há output/cursor; o Ghostty sinaliza via
// wakeup, e nós desenhamos no tick). Capacidade fixa pequena é suficiente.
@class AletheGhosttyView;

#define ALETHE_MAX_SURFACES 256
static ghostty_surface_t g_surfaces[ALETHE_MAX_SURFACES];
static AletheGhosttyView *g_views[ALETHE_MAX_SURFACES];
static int g_surface_count = 0;

// Contador de draws emitidos — instrumentação para o teste de render contínuo
// (#2). Cada chamada a draw incrementa; o teste verifica que cresce sozinho.
static unsigned long long g_draw_count = 0;

static void alethe_draw_surface(ghostty_surface_t s) {
    if (!s) return;
    ghostty_surface_draw(s);
    g_draw_count++;
}

static void alethe_display_link_start(void);
static void alethe_display_link_stop(void);

static void alethe_register_surface(ghostty_surface_t s, AletheGhosttyView *v) {
    if (g_surface_count < ALETHE_MAX_SURFACES) {
        g_surfaces[g_surface_count] = s;
        g_views[g_surface_count] = v;
        g_surface_count++;
        // Primeira surface viva → liga o render contínuo.
        if (g_surface_count == 1) alethe_display_link_start();
    }
}
static void alethe_unregister_surface(ghostty_surface_t s) {
    for (int i = 0; i < g_surface_count; i++) {
        if (g_surfaces[i] == s) {
            g_surfaces[i] = g_surfaces[g_surface_count - 1];
            g_views[i] = g_views[g_surface_count - 1];
            g_views[g_surface_count - 1] = nil;
            g_surface_count--;
            // Nenhuma surface viva → desliga (não gasta GPU à toa).
            if (g_surface_count == 0) alethe_display_link_stop();
            return;
        }
    }
}
static void alethe_draw_all(void) {
    for (int i = 0; i < g_surface_count; i++) {
        if (g_surfaces[i]) alethe_draw_surface(g_surfaces[i]);
    }
}

// ---- Render contínuo (#2) -------------------------------------------------
// Render loop dirigido por um NSTimer a ~60Hz agendado na main run loop em
// NSRunLoopCommonModes. Roda na main thread (onde draw é seguro) e dispara
// tanto no app quanto sob `NSRunLoop runMode:` (testes headless) — ao contrário
// do CVDisplayLink, cujo callback vem de outra thread e não é drenado por
// runMode. A cada tick desenha todas as surfaces vivas.
//
// Objeto-alvo do NSTimer (precisa de um target ObjC com seletor).
@interface AletheRenderTicker : NSObject
- (void)tick:(NSTimer *)t;
@end
@implementation AletheRenderTicker
- (void)tick:(NSTimer *)t {
    (void)t;
    if (g_surface_count > 0) alethe_draw_all();
}
@end

static NSTimer *g_render_timer = NULL;
static AletheRenderTicker *g_render_ticker = NULL;

static void alethe_display_link_start(void) {
    if (g_render_timer != NULL) return;
    if (g_render_ticker == NULL) g_render_ticker = [[AletheRenderTicker alloc] init];
    g_render_timer = [NSTimer timerWithTimeInterval:(1.0 / 60.0)
                                             target:g_render_ticker
                                           selector:@selector(tick:)
                                           userInfo:nil
                                            repeats:YES];
    // Adiciona ao run loop da thread atual (no app: a main thread, via
    // run_on_main_thread no spawn; em teste: a thread do teste). CommonModes
    // para continuar disparando durante drags/resize.
    [[NSRunLoop currentRunLoop] addTimer:g_render_timer forMode:NSRunLoopCommonModes];
}

static void alethe_display_link_stop(void) {
    if (g_render_timer == NULL) return;
    [g_render_timer invalidate];
    g_render_timer = NULL;
}

// ---- Callbacks de runtime -------------------------------------------------
// O wakeup é chamado fora da main thread; agenda o tick na main queue.
static void shim_wakeup_cb(void *userdata) {
    (void)userdata;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (g_app) ghostty_app_tick(g_app);
        // Após processar o trabalho pendente, redesenha as surfaces para o
        // output/cursor aparecerem sem depender de um resize.
        alethe_draw_all();
    });
}

// Não tratamos ações por enquanto (título, notificação, etc.) — retornar false
// diz ao Ghostty para aplicar o comportamento padrão. Paridade vem depois.
static bool shim_action_cb(ghostty_app_t app,
                           ghostty_target_s target,
                           ghostty_action_s action) {
    (void)app; (void)target; (void)action;
    return false;
}

static void shim_close_surface_cb(void *userdata, bool process_alive) {
    (void)userdata; (void)process_alive;
}

static void shim_write_clipboard_cb(void *userdata,
                                    ghostty_clipboard_e clipboard,
                                    const ghostty_clipboard_content_s *contents,
                                    size_t len,
                                    bool confirm) {
    (void)userdata; (void)clipboard; (void)confirm;
    if (len == 0 || contents == NULL || contents[0].data == NULL) return;
    NSString *s = [NSString stringWithUTF8String:contents[0].data];
    if (s == nil) return;
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    [pb setString:s forType:NSPasteboardTypeString];
}

static bool shim_read_clipboard_cb(void *userdata,
                                   ghostty_clipboard_e clipboard,
                                   void *request) {
    (void)clipboard;
    if (userdata == NULL || request == NULL) return false;
    ghostty_surface_t surface = (ghostty_surface_t)userdata;
    NSString *s = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
    const char *c = s ? [s UTF8String] : "";
    ghostty_surface_complete_clipboard_request(surface, c, request, false);
    return true;
}

static void shim_confirm_read_clipboard_cb(void *userdata,
                                           const char *str,
                                           void *request,
                                           ghostty_clipboard_request_e req) {
    (void)req;
    if (userdata == NULL || str == NULL || request == NULL) return;
    ghostty_surface_t surface = (ghostty_surface_t)userdata;
    ghostty_surface_complete_clipboard_request(surface, str, request, true);
}

// ---- Tradução de modificadores AppKit -> Ghostty --------------------------
static ghostty_input_mods_e alethe_mods(NSEventModifierFlags f) {
    uint32_t m = GHOSTTY_MODS_NONE;
    if (f & NSEventModifierFlagShift)   m |= GHOSTTY_MODS_SHIFT;
    if (f & NSEventModifierFlagControl) m |= GHOSTTY_MODS_CTRL;
    if (f & NSEventModifierFlagOption)  m |= GHOSTTY_MODS_ALT;
    if (f & NSEventModifierFlagCommand) m |= GHOSTTY_MODS_SUPER;
    if (f & NSEventModifierFlagCapsLock) m |= GHOSTTY_MODS_CAPS;
    return (ghostty_input_mods_e)m;
}

// ---- NSView customizada que encaminha input pra surface -------------------
// Versão mínima-porém-funcional: cobre digitar texto, Enter, backspace, setas,
// Ctrl+C e mouse/scroll. NÃO reproduz toda a máquina de IME/dead-keys do app
// oficial (isso é uma camada futura), mas é suficiente para USAR o terminal.
@interface AletheGhosttyView : NSView
@property (nonatomic, assign) ghostty_surface_t surface;
@end

@implementation AletheGhosttyView
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder {
    if (self.surface) ghostty_surface_set_focus(self.surface, true);
    return [super becomeFirstResponder];
}
- (BOOL)resignFirstResponder {
    if (self.surface) ghostty_surface_set_focus(self.surface, false);
    return [super resignFirstResponder];
}

- (void)keyDown:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_input_key_s key;
    memset(&key, 0, sizeof(key));
    key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
    key.mods = alethe_mods(event.modifierFlags);
    key.keycode = event.keyCode;
    key.composing = false;

    // unshifted_codepoint: o codepoint da tecla SEM modificadores. É isto que
    // permite ao Ghostty identificar a tecla física (ex.: Ctrl+C -> precisa
    // saber que a tecla é 'c' pra gerar 0x03). Sem isso, Ctrl+C/atalhos não
    // funcionam. Usamos charactersIgnoringModifiers (ignora shift/ctrl/alt).
    NSString *bare = event.charactersIgnoringModifiers;
    if (bare.length > 0) {
        key.unshifted_codepoint = [bare characterAtIndex:0];
    }

    // consumed_mods: todos os modificadores menos Ctrl/Cmd (que ficam livres
    // pro sistema de keybinding do Ghostty casar atalhos como Ctrl+C).
    NSEventModifierFlags consumed =
        event.modifierFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand);
    key.consumed_mods = alethe_mods(consumed);

    // Texto digitável: manda como text só quando não há Ctrl/Cmd (senão são
    // bindings/atalhos que o Ghostty interpreta pelo keycode + unshifted).
    const char *utf8 = NULL;
    NSString *chars = event.characters;
    bool ctrlOrCmd = (event.modifierFlags &
        (NSEventModifierFlagControl | NSEventModifierFlagCommand)) != 0;
    if (!ctrlOrCmd && chars.length > 0) {
        utf8 = [chars UTF8String];
    }
    key.text = utf8;
    ghostty_surface_key(self.surface, key);
}

- (void)keyUp:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_input_key_s key;
    memset(&key, 0, sizeof(key));
    key.action = GHOSTTY_ACTION_RELEASE;
    key.mods = alethe_mods(event.modifierFlags);
    key.keycode = event.keyCode;
    NSString *bare = event.charactersIgnoringModifiers;
    if (bare.length > 0) key.unshifted_codepoint = [bare characterAtIndex:0];
    ghostty_surface_key(self.surface, key);
}

- (NSPoint)ghosttyPoint:(NSEvent *)event {
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    // Ghostty espera y crescendo pra baixo a partir do topo da view.
    return NSMakePoint(p.x, self.bounds.size.height - p.y);
}

- (void)mouseDown:(NSEvent *)event {
    if (!self.surface) return;
    [self.window makeFirstResponder:self];
    NSPoint p = [self ghosttyPoint:event];
    ghostty_surface_mouse_pos(self.surface, p.x, p.y, alethe_mods(event.modifierFlags));
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS,
                                 GHOSTTY_MOUSE_LEFT, alethe_mods(event.modifierFlags));
}
- (void)mouseUp:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE,
                                 GHOSTTY_MOUSE_LEFT, alethe_mods(event.modifierFlags));
}
- (void)mouseMoved:(NSEvent *)event   { [self forwardPos:event]; }
- (void)mouseDragged:(NSEvent *)event { [self forwardPos:event]; }
- (void)forwardPos:(NSEvent *)event {
    if (!self.surface) return;
    NSPoint p = [self ghosttyPoint:event];
    ghostty_surface_mouse_pos(self.surface, p.x, p.y, alethe_mods(event.modifierFlags));
}
- (void)scrollWheel:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_surface_mouse_scroll(self.surface, event.scrollingDeltaX,
                                 event.scrollingDeltaY, 0);
}
@end

// ---- API pública ----------------------------------------------------------

bool alethe_ghostty_ensure_app(void) {
    if (g_app != NULL) return true;

    // ghostty_init é global e idempotente do nosso lado (só chamamos quando
    // ainda não há app).
    ghostty_init(0, NULL);

    g_config = ghostty_config_new();
    if (g_config == NULL) return false;
    ghostty_config_finalize(g_config);

    ghostty_runtime_config_s rt;
    memset(&rt, 0, sizeof(rt));
    rt.userdata = NULL;
    rt.supports_selection_clipboard = false;
    rt.wakeup_cb = shim_wakeup_cb;
    rt.action_cb = shim_action_cb;
    rt.read_clipboard_cb = shim_read_clipboard_cb;
    rt.confirm_read_clipboard_cb = shim_confirm_read_clipboard_cb;
    rt.write_clipboard_cb = shim_write_clipboard_cb;
    rt.close_surface_cb = shim_close_surface_cb;

    g_app = ghostty_app_new(&rt, g_config);
    return g_app != NULL;
}

alethe_surface_t alethe_ghostty_surface_new(void *superview,
                                            const char *cwd,
                                            const char *command,
                                            double scale_factor) {
    if (!alethe_ghostty_ensure_app()) return NULL;
    if (superview == NULL) return NULL;

    // Cria a NSView customizada que recebe input e hospeda a surface, e a anexa
    // à superview (content view da janela do Tauri) fornecida pelo Rust.
    NSView *parent = (__bridge NSView *)superview;
    AletheGhosttyView *view = [[AletheGhosttyView alloc] initWithFrame:parent.bounds];
    view.wantsLayer = YES;
    [parent addSubview:view];

    ghostty_surface_config_s cfg = ghostty_surface_config_new();
    cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
    cfg.platform.macos.nsview = (__bridge void *)view;
    cfg.userdata = NULL;
    cfg.backend = GHOSTTY_SURFACE_IO_BACKEND_EXEC;
    cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;
    cfg.scale_factor = scale_factor > 0 ? scale_factor : 2.0;
    if (cwd != NULL && cwd[0] != '\0') cfg.working_directory = cwd;
    if (command != NULL && command[0] != '\0') cfg.command = command;

    ghostty_surface_t surface = ghostty_surface_new(g_app, &cfg);
    if (surface == NULL) {
        [view removeFromSuperview];
        return NULL;
    }
    view.surface = surface;
    alethe_register_surface(surface, view);

    // Guardamos a view no userdata da surface pra recuperá-la em set_frame/free
    // e tornar a view first responder.
    [view.window makeFirstResponder:view];
    return (alethe_surface_t)surface;
}

// Recupera a AletheGhosttyView associada a uma surface (busca no registro).
static AletheGhosttyView *alethe_view_for_surface(ghostty_surface_t s) {
    for (int i = 0; i < g_surface_count; i++) {
        if (g_surfaces[i] == s) return g_views[i];
    }
    return nil;
}

// Posiciona a NSView (em pontos AppKit, origem inferior-esquerda) — chamado pelo
// Rust no sync_frame. Mantém a view alinhada ao placeholder do DOM.
void alethe_ghostty_surface_set_frame(alethe_surface_t surface,
                                      double x, double y,
                                      double w, double h) {
    if (surface == NULL) return;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    if (v) v.frame = NSMakeRect(x, y, w < 1 ? 1 : w, h < 1 ? 1 : h);
}

void alethe_ghostty_surface_set_hidden(alethe_surface_t surface, bool hidden) {
    if (surface == NULL) return;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    if (v) v.hidden = hidden;
}

void alethe_ghostty_surface_set_size(alethe_surface_t surface,
                                     unsigned int width_px,
                                     unsigned int height_px) {
    if (surface == NULL) return;
    ghostty_surface_set_size((ghostty_surface_t)surface,
                             (uint32_t)width_px, (uint32_t)height_px);
}

void alethe_ghostty_surface_set_content_scale(alethe_surface_t surface,
                                              double x, double y) {
    if (surface == NULL) return;
    ghostty_surface_set_content_scale((ghostty_surface_t)surface, x, y);
}

void alethe_ghostty_surface_set_focus(alethe_surface_t surface, bool focused) {
    if (surface == NULL) return;
    ghostty_surface_set_focus((ghostty_surface_t)surface, focused);
}

void alethe_ghostty_surface_draw(alethe_surface_t surface) {
    if (surface == NULL) return;
    alethe_draw_surface((ghostty_surface_t)surface);
}

unsigned long long alethe_ghostty_draw_count(void) {
    return g_draw_count;
}

void alethe_ghostty_surface_free(alethe_surface_t surface) {
    if (surface == NULL) return;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    alethe_unregister_surface((ghostty_surface_t)surface);
    ghostty_surface_free((ghostty_surface_t)surface);
    [v removeFromSuperview];
}

void alethe_ghostty_app_tick(void) {
    if (g_app) ghostty_app_tick(g_app);
}

void alethe_ghostty_surface_send_text(alethe_surface_t surface,
                                      const char *utf8,
                                      size_t len) {
    if (surface == NULL || utf8 == NULL || len == 0) return;
    ghostty_surface_text((ghostty_surface_t)surface, utf8, (uintptr_t)len);
}

size_t alethe_ghostty_surface_read_screen(alethe_surface_t surface,
                                          char *out,
                                          size_t cap) {
    if (surface == NULL || out == NULL || cap == 0) return 0;
    out[0] = '\0';

    // Seleção cobrindo o viewport inteiro: do topo-esquerda ao baixo-direita.
    ghostty_selection_s sel;
    memset(&sel, 0, sizeof(sel));
    sel.top_left.tag = GHOSTTY_POINT_VIEWPORT;
    sel.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
    sel.top_left.x = 0;
    sel.top_left.y = 0;
    sel.bottom_right.tag = GHOSTTY_POINT_VIEWPORT;
    sel.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
    sel.bottom_right.x = 0;
    sel.bottom_right.y = 0;
    sel.rectangle = false;

    ghostty_text_s text;
    memset(&text, 0, sizeof(text));
    if (!ghostty_surface_read_text((ghostty_surface_t)surface, sel, &text)) {
        return 0;
    }
    size_t n = 0;
    if (text.text != NULL && text.text_len > 0) {
        n = (size_t)text.text_len;
        if (n >= cap) n = cap - 1;
        memcpy(out, text.text, n);
        out[n] = '\0';
    }
    ghostty_surface_free_text((ghostty_surface_t)surface, &text);
    return n;
}
