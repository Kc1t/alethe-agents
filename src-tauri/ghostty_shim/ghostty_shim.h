// Shim C sobre o libghostty. Existe para o Rust não precisar reproduzir a ABI
// das structs grandes passadas por valor (ghostty_action_s, etc.) — fazê-lo à
// mão é frágil. O shim inclui o ghostty.h real (ABI garantida pelo compilador
// C) e expõe uma API mínima e estável, suficiente para embutir uma surface
// numa NSView.
//
// Convenção de nomes: tudo prefixado `alethe_ghostty_`.
#ifndef ALETHE_GHOSTTY_SHIM_H
#define ALETHE_GHOSTTY_SHIM_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Handle opaco de uma surface (na prática um ghostty_surface_t).
typedef void *alethe_surface_t;

// Garante que o app global do Ghostty existe (init + config + app_new com os
// callbacks de runtime). Idempotente. Retorna true se o app está pronto.
// Deve ser chamado na main thread.
bool alethe_ghostty_ensure_app(void);

// Cria a surface DENTRO de uma NSView própria (que recebe input) anexada como
// subview de `superview` (a content view da NSWindow do Tauri). `command`
// (NULL = shell padrão) e `cwd` (NULL = padrão) configuram o processo que o
// Ghostty spawna no backend EXEC. Retorna NULL em falha. Main thread.
alethe_surface_t alethe_ghostty_surface_new(void *superview,
                                            const char *cwd,
                                            const char *command,
                                            double scale_factor);

// Posiciona a NSView da surface (coordenadas AppKit, origem inferior-esquerda).
void alethe_ghostty_surface_set_frame(alethe_surface_t surface,
                                      double x, double y,
                                      double w, double h);

// Mostra/esconde a NSView da surface (ex.: ocultar sob um modal).
void alethe_ghostty_surface_set_hidden(alethe_surface_t surface, bool hidden);

// Ajusta tamanho (em PIXELS de dispositivo) e escala de conteúdo da surface.
void alethe_ghostty_surface_set_size(alethe_surface_t surface,
                                     unsigned int width_px,
                                     unsigned int height_px);
void alethe_ghostty_surface_set_content_scale(alethe_surface_t surface,
                                              double x,
                                              double y);

// Foco e desenho (chamado pelo tick/displaylink).
void alethe_ghostty_surface_set_focus(alethe_surface_t surface, bool focused);
void alethe_ghostty_surface_draw(alethe_surface_t surface);

// Libera a surface.
void alethe_ghostty_surface_free(alethe_surface_t surface);

// Avança o event loop do app (deve ser chamado quando o wakeup dispara e/ou
// periodicamente). Main thread.
void alethe_ghostty_app_tick(void);

// --- Helpers de teste/automação --------------------------------------------
// Envia texto pro terminal (como se fosse digitado). Use "\r" para Enter.
void alethe_ghostty_surface_send_text(alethe_surface_t surface,
                                      const char *utf8,
                                      size_t len);

// Lê todo o conteúdo visível da tela (viewport) como UTF-8. Copia até
// `cap` bytes em `out` (NUL-terminado) e retorna o nº de bytes escritos.
// Retorna 0 se não houver nada/erro. Usado pelos testes funcionais.
size_t alethe_ghostty_surface_read_screen(alethe_surface_t surface,
                                          char *out,
                                          size_t cap);

// Nº acumulado de draws emitidos (instrumentação p/ o teste de render
// contínuo, #2). Cresce com o display link e com draws explícitos.
unsigned long long alethe_ghostty_draw_count(void);

#ifdef __cplusplus
}
#endif

#endif // ALETHE_GHOSTTY_SHIM_H
