# Home, shell and workspace parity handoff

Source: `origin/main` (`f09c597`), read with `git show`; no checkout, commit or push.

## Outcome and source values

- `src/components/HomeView/index.tsx`, `HomeView.module.css`,
  `src/components/ui/ascii-effect.tsx` and `src/assets/home-bg-right.png` supply the Home art.
  The bundled PNG is byte-identical. The Canvas uses the original character ramp, cover fit,
  8-point cells, brightness 2.25, contrast 1.15, threshold 0.02, 32-level quantization,
  flow speed 0.16, strength 9, pointer radius 260 and strength 16. Theme ink interpolates
  between fg-muted and fg. Row opacity reproduces the CSS fade without gradient layers.
- The final Home CSS overrides, rather than earlier declarations, control proportions:
  greeting 34, profile 44, quick launch maximum 620, agent field 145, mode field 132,
  selector icons 15 (19 in the agent menu), recent avatar 28, recent title 11 and card minimum height 44 points.
  The often-cited 34-point project avatar is overridden to 28 in `.overviewGrid`.
  Existing Recent, Start something and Usage layouts already contain these final values.
- Quick-launch asset copies have bounded intrinsic dimensions as well as explicit view frames,
  including images bridged into AppKit menus. Compact toolbar wrapping follows the Home
  container's 620-point breakpoint. Launch/date backgrounds now use the CSS opacities.
- `ProjectSidebar/NormalProjectSidebar.tsx` supplies the Home/Projects/Files/Git icon order.
  Home resets Projects; Git opens the existing native Git Control sheet.
- The web title bar reserves 72 scaled points before its hamburger; the native title bar remains.
- Remaining literal SwiftUI divider dimensions and the sub-tab close font use metrics.
  Clean web mode suppresses launch/search/tab/sub-tab/drag shadows and hover translation.
  Layout offsets that position status badges and lane markers remain intentional.

## Validation and remaining differences

- `python3 AletheNative/Scripts/check-strings.py`: passed; no new localization keys needed.
- `git diff --check` and a Python scan using ColorLintTests patterns: passed.
- No build, launch, restart or UI harness run, as instructed.
- Reviewer must build and compare Home at 1280×800 and zoom 0.8–1.5, including narrow toolbar
  wrapping, light/dark themes, reduced motion and clean styling. Static review cannot establish
  pixel parity or runtime performance of the Canvas.
- Git is a functional shortcut to the existing sheet, rather than an inline plugin sidebar;
  the native plugin currently contributes only a sheet. No model or plugin schema was changed.
- SF Symbols and metrics-based system fonts remain platform equivalents to Lucide and web fonts.
  ASCII colors are quantized to 32 cached ink levels to avoid resolving text for every cell.
- No ai-memory skill, connector or CLI is available in this session. This handoff records the
  decisions, validation limits and reviewer next steps; it does not claim an ai-memory write.

## Image sizing follow-up

- Re-read `origin/main:src/components/HomeView/index.tsx` and `HomeView.module.css`: the agent
  summary uses a 15-point icon, menu options use 19, and chevrons use 10. These replace the prior
  uniform 16-point agent sizing. Frames and intrinsic menu bitmap dimensions agree.
- Image and Label icons throughout Home now receive explicit web-only resizable fit bounds.
  The shared helper returns the original image when `metrics.isWebInterface` is false.
- Menu images are rasterized to new representations, avoiding AppKit selecting a full-size
  source bitmap. Final runtime/menu verification remains with the reviewer; no build was run.
