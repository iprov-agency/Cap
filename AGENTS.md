# Cap

Generated: 2026-04-09 18:38 | Files: 1612 | Functions: 10225 | Relationships: 126729 | Languages: javascript, rust, tsx, typescript

This file is auto-generated from the code-review-graph knowledge graph and the corrections database. Do not edit manually. It will be regenerated after each build cycle.

## Always Start Here

Before making any code changes in this repo:

1. Read this file for architecture overview and key files
2. Read CLAUDE.md for project-specific design patterns and constraints
3. Check the **Known Constraints** section below for rules from past build failures
4. Use the code-review-graph MCP tools to query relationships before reading raw source:

| Tool | What it gives you |
|---|---|
| `build_or_update_graph_tool` | Rebuild or incrementally update the graph |
| `get_impact_radius_tool` | Blast radius: what breaks if you change these files |
| `query_graph_tool` | Callers, callees, imports, tests for any symbol |
| `get_review_context_tool` | Focused context with source snippets for changed files |
| `semantic_search_nodes_tool` | Find functions/classes by keyword |
| `find_large_functions_tool` | Oversized functions that may need refactoring |

## Architecture Overview

Most-referenced functions and components (project-specific, library calls excluded):

| Function | Call Sites | File |
|---|---|---|
| `Some` | 3063 | `crates/cap-test/src/suites/performance.rs` |
| `unwrap` | 1649 | `crates/cap-test/src/suites/playback.rs` |
| `expect` | 1558 | `apps/desktop/scripts/desktop-memory-soak.test.js` |
| `Ok` | 1535 | `crates/cap-test/src/matrix/runner.rs` |
| `clone` | 1481 | `crates/cap-test/src/matrix/runner.rs` |
| `println` | 1106 | `crates/export/tests/long_video_export.rs` |
| `format` | 1075 | `crates/cap-test/src/suites/performance.rs` |
| `map_err` | 963 | `apps/cli/src/main.rs` |
| `to_string` | 808 | `crates/cap-test/src/suites/performance.rs` |
| `assert` | 781 | `crates/export/tests/long_video_export.rs` |
| `Err` | 723 | `apps/cli/src/record.rs` |
| `contains` | 699 | `crates/recording/tests/hardware_compat.rs` |
| `iter` | 673 | `crates/cap-test/src/suites/playback.rs` |
| `set` | 639 | `apps/desktop/scripts/desktop-memory-soak-lib.js` |
| `toBe` | 630 | `apps/desktop/scripts/desktop-memory-soak.test.js` |

## Key Files (by connectivity)

Files with the most relationships (imports, calls, dependencies). Changes to these files have the largest blast radius.

| File | Relationships |
|---|---|
| `apps/desktop/src-tauri/src/lib.rs` | 2165 |
| `crates/enc-avfoundation/src/mp4.rs` | 1559 |
| `crates/recording/tests/instant_mode_scenarios.rs` | 1458 |
| `vendor/wgpu-hal/src/vulkan/device.rs` | 1249 |
| `apps/desktop/src-tauri/src/windows.rs` | 1226 |
| `apps/desktop/src-tauri/src/captions.rs` | 1215 |
| `crates/rendering/src/lib.rs` | 1113 |
| `apps/desktop/src-tauri/src/recording.rs` | 1101 |
| `crates/recording/src/output_pipeline/core.rs` | 1066 |
| `crates/recording/tests/recovery.rs` | 982 |
| `vendor/tao/src/platform_impl/windows/event_loop.rs` | 919 |
| `crates/recording/examples/real-device-test-runner.rs` | 881 |
| `apps/desktop/src-tauri/src/upload.rs` | 811 |
| `vendor/wgpu-hal/src/vulkan/adapter.rs` | 803 |
| `apps/web/__tests__/unit/developer-actions.test.ts` | 790 |

## Key Relationships (Import Dependencies)

Most-imported internal modules. Shows who depends on whom. Changes to these files affect all importers.

| File | Imported By | Count |
|---|---|---|
| `apps/desktop/src/utils/tauri.ts` | `apps/desktop/src/App.tsx`, `apps/desktop/src/components/Cropper.tsx`, `apps/desktop/src/components/Mode.tsx` +71 more | 74 |
| `apps/web/app/(org)/dashboard/Contexts.tsx` | `apps/web/app/(org)/dashboard/_components/MobileTab.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/CapAIBox.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/CapAIDialog.tsx` +57 more | 60 |
| `apps/web/utils/web-schema.ts` | `apps/web/__tests__/unit/async-video-code-reviews-page.test.ts`, `apps/web/__tests__/unit/avi-to-mp4-page.test.ts`, `apps/web/__tests__/unit/best-screen-recorder-page.test.ts` +42 more | 45 |
| `apps/web/lib/server.ts` | `apps/web/actions/admin/replace-video.ts`, `apps/web/actions/organization/delete-space.ts`, `apps/web/actions/organization/update-space.ts` +39 more | 42 |
| `apps/desktop/src/routes/editor/context.ts` | `apps/desktop/src/routes/editor/AspectRatioSelect.tsx`, `apps/desktop/src/routes/editor/CaptionsTab.tsx`, `apps/desktop/src/routes/editor/ConfigSidebar.tsx` +25 more | 28 |
| `apps/desktop/src/store.ts` | `apps/desktop/src/App.tsx`, `apps/desktop/src/routes/(window-chrome)/new-main/index.tsx`, `apps/desktop/src/routes/(window-chrome)/onboarding.tsx` +22 more | 25 |
| `apps/web/components/seo/types.ts` | `apps/web/components/pages/seo/AgenciesPage.tsx`, `apps/web/components/pages/seo/AsyncVideoCodeReviewsPage.tsx`, `apps/web/components/pages/seo/BestScreenRecorderPage.tsx` +21 more | 24 |
| `apps/web/components/seo/SeoPageTemplate.tsx` | `apps/web/components/features/FeaturePage.tsx`, `apps/web/components/pages/seo/AsyncVideoCodeReviewsPage.tsx`, `apps/web/components/pages/seo/BestScreenRecorderPage.tsx` +20 more | 23 |
| `apps/desktop/src/routes/editor/ui.tsx` | `apps/desktop/src/routes/(window-chrome)/new-main/index.tsx`, `apps/desktop/src/routes/(window-chrome)/settings/general.tsx`, `apps/desktop/src/routes/(window-chrome)/settings/integrations/s3-config.tsx` +18 more | 21 |
| `apps/web/components/SignedImageUrl.tsx` | `apps/web/app/(org)/dashboard/_components/MobileTab.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/MemberAvatars.tsx` +17 more | 20 |
| `apps/web/lib/EffectRuntime.ts` | `apps/web/app/(org)/dashboard/analytics/components/AnalyticsDashboard.tsx`, `apps/web/app/(org)/dashboard/caps/Caps.tsx`, `apps/web/app/(org)/dashboard/caps/components/CapCard/CapCard.tsx` +17 more | 20 |
| `packages/web-backend/src/Database.ts` | `packages/web-backend/src/Auth.ts`, `packages/web-backend/src/Folders/FoldersPolicy.ts`, `packages/web-backend/src/Folders/FoldersRepo.ts` +16 more | 19 |
| `apps/desktop/src/routes/screenshot-editor/context.tsx` | `apps/desktop/src/routes/screenshot-editor/AnnotationConfig.tsx`, `apps/desktop/src/routes/screenshot-editor/AnnotationLayer.tsx`, `apps/desktop/src/routes/screenshot-editor/AnnotationTools.tsx` +14 more | 17 |
| `apps/web/lib/utils.ts` | `apps/web/app/(org)/dashboard/_components/AnimatedIcons/ArrowUp.tsx`, `apps/web/app/(org)/dashboard/_components/AnimatedIcons/Cap.tsx`, `apps/web/app/(org)/dashboard/_components/AnimatedIcons/ChartLine.tsx` +14 more | 17 |
| `apps/desktop/src/components/Tooltip.tsx` | `apps/desktop/src/components/Mode.tsx`, `apps/desktop/src/routes/(window-chrome)/new-main/ChangeLogButton.tsx`, `apps/desktop/src/routes/(window-chrome)/new-main/TargetCard.tsx` +13 more | 16 |

## File Structure

```
apps/cli/src/
  main.rs  (2 functions)
  record.rs  (1 functions)
apps/desktop/
  app.config.ts
  tailwind.config.js
  vitest.config.ts
apps/desktop/scripts/
  desktop-memory-soak-lib.js  (10 functions)
  desktop-memory-soak.js  (18 functions)
  desktop-memory-soak.test.js
  prepare.js  (4 functions)
  prodBeforeBundle.js  (2 functions)
apps/desktop/src/
  App.tsx  (4 functions)
  declaration.d.ts
  entry-client.tsx  (1 functions)
  entry-server.tsx
  global.d.ts
  icons.tsx  (5 functions)
  store.ts  (4 functions)
  vite-env.d.ts
apps/desktop/src-tauri/
  build.rs  (1 functions)
apps/desktop/src-tauri/src/
  api.rs  (7 functions)
  audio.rs  (4 functions)
  audio_meter.rs  (8 functions)
  auth.rs  (5 functions)
  camera.rs  (30 functions)
  camera_legacy.rs  (1 functions)
  captions.rs  (35 functions)
  deeplink_actions.rs  (3 functions)
  editor_window.rs  (14 functions)
  exit_shutdown.rs  (5 functions)
  export.rs  (17 functions)
  fake_window.rs  (7 functions)
  flags.rs  (1 functions)
  frame_ws.rs  (6 functions)
  general_settings.rs  (15 functions)
  gpu_context.rs  (7 functions)
  hotkeys.rs  (5 functions)
  http_client.rs  (2 functions)
  import.rs  (9 functions)
  lib.rs  (128 functions)
  logging.rs  (6 functions)
  main.rs  (1 functions)
  notifications.rs  (5 functions)
  panel_manager.rs  (12 functions)
  permissions.rs  (24 functions)
  posthog.rs  (4 functions)
  presets.rs  (5 functions)
  recording.rs  (57 functions)
  recording_settings.rs  (3 functions)
  recovery.rs  (5 functions)
  resource.rs  (3 functions)
  screenshot_editor.rs  (15 functions)
  target_select_overlay.rs  (12 functions)
  tray.rs  (22 functions)
  update_project_names.rs  (6 functions)
  upload.rs  (30 functions)
  web_api.rs  (9 functions)
  window_exclusion.rs  (2 functions)
  windows.rs  (41 functions)
apps/desktop/src-tauri/src/platform/
  mod.rs  (2 functions)
  win.rs
apps/desktop/src-tauri/src/platform/macos/
  delegates.rs  (23 functions)
  mod.rs  (2 functions)
  sc_shareable_content.rs  (9 functions)
apps/desktop/src-tauri/src/thumbnails/
  mac.rs  (19 functions)
  mod.rs  (3 functions)
  windows.rs  (2 functions)
apps/desktop/src-tauri/tests/
  exit_shutdown.rs  (9 functions)
  web_api_startup.rs  (2 functions)
apps/desktop/src/components/
  CapErrorBoundary.tsx  (1 functions)
  Cropper.tsx  (39 functions)
  Loader.tsx  (1 functions)
  Mode.tsx  (2 functions)
  ModeSelect.tsx  (3 functions)
  RecoveryToast.tsx  (8 functions)
  SignInButton.tsx  (1 functions)
  SwitchTab.tsx
  Toggle.tsx  (1 functions)
  Tooltip.tsx  (2 functions)
  TooltipIconButton.tsx
  callback.template.ts
  selection-hint.tsx  (1 functions)
apps/desktop/src/components/titlebar/
  Titlebar.tsx  (3 functions)
apps/desktop/src/components/titlebar/controls/
  CaptionControlsMacOS.tsx  (7 functions)
  CaptionControlsWindows11.tsx  (1 functions)
  WindowControlButton.tsx  (1 functions)
apps/desktop/src/routes/
  (window-chrome).tsx  (2 functions)
  camera.tsx  (29 functions)
  capture-area.tsx  (6 functions)
  debug.tsx  (4 functions)
  in-progress-recording.tsx  (24 functions)
  mode-select.tsx  (1 functions)
  notifications.tsx  (2 functions)
  recordings-overlay.tsx  (13 functions)
  target-select-overlay.tsx  (26 functions)
  window-capture-occluder.tsx  (1 functions)
apps/desktop/src/routes/(window-chrome)/
  Context.tsx  (3 functions)
  OptionsContext.tsx  (1 functions)
  icons.tsx  (1 functions)
  onboarding.tsx  (54 functions)
  settings.tsx  (2 functions)
  update.tsx
  upgrade.tsx  (3 functions)
apps/desktop/src/routes/(window-chrome)/new-main/
  CameraSelect.tsx  (7 functions)
  ChangeLogButton.tsx  (2 functions)
  DeviceSelectOverlay.tsx  (5 functions)
  InfoPill.tsx  (1 functions)
  MicrophoneSelect.tsx  (5 functions)
  ModeInfoPanel.tsx  (3 functions)
  SystemAudio.tsx  (5 functions)
  TargetCard.tsx  (18 functions)
  TargetDropdownButton.tsx  (1 functions)
  TargetMenuGrid.tsx  (9 functions)
  TargetSelectInfoPill.tsx  (1 functions)
  TargetTypeButton.tsx  (1 functions)
  index.tsx  (43 functions)
  useRequestPermission.ts  (2 functions)
apps/desktop/src/routes/(window-chrome)/settings/
  Setting.tsx  (2 functions)
  changelog.tsx  (1 functions)
  experimental.tsx  (3 functions)
  feedback.tsx  (4 functions)
  general.tsx  (28 functions)
  hotkeys.tsx  (3 functions)
  index.tsx  (1 functions)
  license.tsx  (3 functions)
  recordings.tsx  (12 functions)
  screenshots.tsx  (8 functions)
  transcription.tsx  (5 functions)
apps/desktop/src/routes/(window-chrome)/settings/integrations/
  index.tsx  (3 functions)
  s3-config.tsx  (3 functions)
apps/desktop/src/routes/editor/
  AspectRatioSelect.tsx  (3 functions)
  CaptionsTab.tsx  (17 functions)
  ConfigSidebar.tsx  (44 functions)
  Editor.tsx  (34 functions)
  EditorErrorScreen.tsx  (5 functions)
  ExportPage.tsx  (27 functions)
  GradientEditor.tsx  (6 functions)
  Header.tsx  (5 functions)
  ImportProgress.tsx  (3 functions)
  KeyboardTab.tsx  (8 functions)
  MaskOverlay.tsx  (21 functions)
  PerformanceOverlay.tsx  (6 functions)
  Player.tsx  (19 functions)
  PresetsDropdown.tsx  (2 functions)
  ShadowSettings.tsx  (2 functions)
  ShareButton.tsx  (5 functions)
  TextInput.tsx  (1 functions)
  TextOverlay.tsx  (19 functions)
  TranscriptPage.tsx  (22 functions)
  captions.ts  (14 functions)
  color-utils.tsx  (4 functions)
  context.ts  (22 functions)
  editor-skeleton.tsx  (11 functions)
  index.tsx
  masks.ts  (7 functions)
  projectConfig.ts
  text-style.tsx  (3 functions)
  text.ts  (1 functions)
  timeline-utils.ts  (5 functions)
  timelineTracks.ts  (6 functions)
  ui.tsx  (17 functions)
  useEditorShortcuts.ts  (3 functions)
  utils.ts  (2 functions)
apps/desktop/src/routes/editor/Timeline/
  CaptionsTrack.tsx  (8 functions)
  ClipTrack.tsx  (25 functions)
  KeyboardTrack.tsx  (8 functions)
  MaskTrack.tsx  (16 functions)
  SceneTrack.tsx  (7 functions)
  TextTrack.tsx  (13 functions)
  Track.tsx  (8 functions)
  TrackManager.tsx  (3 functions)
  ZoomTrack.tsx  (16 functions)
  context.ts  (2 functions)
  index.tsx  (34 functions)
  sectionMarker.ts  (1 functions)
apps/desktop/src/routes/screenshot-editor/
  AnnotationConfig.tsx  (8 functions)
  AnnotationLayer.tsx  (15 functions)
  AnnotationTools.tsx  (2 functions)
  ColorPicker.tsx  (3 functions)
  Editor.tsx  (9 functions)
  Header.tsx  (5 functions)
  LayersPanel.tsx  (16 functions)
  Preview.tsx  (28 functions)
  TextInput.tsx  (1 functions)
  arrow.ts  (2 functions)
  context.tsx  (12 functions)
  index.tsx  (1 functions)
  layout.ts  (2 functions)
  screenshot-editor-skeleton.tsx  (5 functions)
  ui.tsx  (17 functions)
  useScreenshotExport.ts  (9 functions)
apps/desktop/src/routes/screenshot-editor/popovers/
  AnnotationPopover.tsx  (2 functions)
  AspectRatioSelect.tsx  (3 functions)
  BackgroundSettingsPopover.tsx  (5 functions)
  BorderPopover.tsx  (1 functions)
  PaddingPopover.tsx  (3 functions)
  RoundingPopover.tsx  (4 functions)
  ShadowPopover.tsx  (1 functions)
  ShadowSettings.tsx  (2 functions)
apps/desktop/src/store/
  captions.ts  (11 functions)
  keyboard.ts
apps/desktop/src/utils/
  analytics.ts  (3 functions)
  auth.ts  (11 functions)
  composeEventHandlers.ts  (2 functions)
  createEventListener.ts  (2 functions)
  createPresets.ts  (2 functions)
  devices.ts  (11 functions)
  env.ts
  events.ts  (2 functions)
  export.ts  (3 functions)
  frame-worker.ts  (14 functions)
  general-settings.test.ts
  general-settings.ts  (5 functions)
  hex-color.test.ts
  hex-color.ts  (4 functions)
  os-permissions.test.ts
  os-permissions.ts  (3 functions)
  plans.ts  (2 functions)
  queries.ts  (12 functions)
  recording.ts  (1 functions)
  rive.ts  (1 functions)
  shared-frame-buffer.ts  (13 functions)
  socket.ts  (11 functions)
  stride-correction-worker.ts
  tauri.ts  (117 functions)
  tauriSpectaHack.ts  (1 functions)
  titlebar-state.ts  (1 functions)
  web-api.ts  (3 functions)
  webgpu-renderer.ts  (5 functions)
apps/discord-bot/
  worker-configuration.d.ts
apps/discord-bot/src/
  index.ts  (6 functions)
apps/discord-bot/test/
  index.spec.ts
apps/media-server/src/
  app.ts
  index.ts  (1 functions)
apps/media-server/src/__tests__/
  index.test.ts
apps/media-server/src/__tests__/lib/
  ffmpeg-video.integration.test.ts
  ffmpeg.integration.test.ts
  ffprobe.integration.test.ts
  memory-leak.test.ts  (4 functions)
apps/media-server/src/__tests__/routes/
  audio-memory.test.ts  (2 functions)
  audio.test.ts  (1 functions)
  health.test.ts
  video.test.ts  (2 functions)
apps/media-server/src/lib/
  ffmpeg-video.ts  (31 functions)
  ffmpeg.ts  (12 functions)
  ffprobe.ts  (8 functions)
  job-manager.ts  (16 functions)
  subprocess.ts  (5 functions)
  temp-files.ts  (4 functions)
apps/media-server/src/routes/
  audio.ts  (2 functions)
  health.ts
  video.ts  (23 functions)
apps/src/utils/
  tauri.ts  (111 functions)
apps/storybook/
  tailwind.config.js
  vite.config.ts
  vite.config.ts.timestamp-1735325995918-46a167c39672.mjs
apps/storybook/.storybook/
  main.ts  (1 functions)
  preview.ts
apps/web/
  global.d.ts
  instrumentation.node.ts  (4 functions)
  instrumentation.ts  (1 functions)
  next.config.mjs  (2 functions)
  postcss.config.js
  proxy.ts  (2 functions)
  tailwind.config.js
  vitest.config.ts
apps/web-cluster/scripts/
  post-deploy.ts
apps/web-cluster/src/
  health-check.ts  (1 functions)
  shard-manager.ts
apps/web-cluster/src/cluster/
  container-metadata.ts
apps/web-cluster/src/runner/
  health-server.ts
  index.ts
apps/web-cluster/src/shared/
  database.ts
apps/web/__tests__/
  setup.ts
apps/web/__tests__/fixtures/
  deepgram-responses.ts
apps/web/__tests__/integration/
  transcribe.test.ts
apps/web/__tests__/unit/
  async-video-code-reviews-page.test.ts
  audio-extract.test.ts
  avi-to-mp4-page.test.ts
  best-screen-recorder-page.test.ts
  breadcrumb-schema.test.ts  (1 functions)
  canonical-urls.test.ts  (1 functions)
  developer-actions.test.ts  (4 functions)
  developer-api-auth.test.ts  (5 functions)
  developer-credit-math.test.ts  (5 functions)
  developer-credits-checkout.test.ts  (5 functions)
  developer-credits-webhook.test.ts  (7 functions)
  developer-cron-storage.test.ts  (7 functions)
  developer-documentation-videos-page.test.ts
  developer-domain-validation.test.ts  (1 functions)
  developer-key-hash.test.ts
  email-restriction.test.ts
  faq-schema.test.ts
  hipaa-compliant-screen-recording-page.test.ts
  howto-schema.test.ts
  instant-recording-uploader.test.ts  (8 functions)
  local-recording-backup.test.ts  (1 functions)
  loom-import.test.ts  (3 functions)
  mac-screen-recording-with-audio-page.test.ts
  media-client.test.ts
  mov-to-mp4-page.test.ts
  mp4-to-gif-page.test.ts
  multipart-upload-utils.test.ts
  obs-alternative-page.test.ts
  open-source-screen-recorder-page.test.ts
  playback-source.test.ts  (1 functions)
  recording-spool-fallback.test.ts  (1 functions)
  recording-spool.test.ts  (17 functions)
  recovered-recording-cache.test.ts
  self-hosted-screen-recording-page.test.ts
  seo-registry.test.ts
  transcribe-utils.test.ts
  upload-progress-playback.test.ts
  video-convert.test.ts
  video-processing.test.ts
  video-recording-software-page.test.ts
  video-speed-controller-page.test.ts
  videos-policy.test.ts  (5 functions)
  web-recorder-utils.test.ts
  webm-to-mp4-page.test.ts
apps/web/actions/
  loom.ts  (8 functions)
  messenger.ts  (13 functions)
apps/web/actions/admin/
  replace-video.ts  (4 functions)
apps/web/actions/analytics/
  track-user-signed-up.ts  (3 functions)
apps/web/actions/billing/
  track-meta-purchase.ts  (1 functions)
apps/web/actions/caps/
  share.ts  (1 functions)
apps/web/actions/developers/
  add-domain.ts  (1 functions)
  create-app.ts  (1 functions)
  delete-app.ts  (1 functions)
  delete-video.ts  (1 functions)
  regenerate-keys.ts  (1 functions)
  remove-domain.ts  (1 functions)
  update-app.ts  (1 functions)
  update-auto-topup.ts  (1 functions)
apps/web/actions/folders/
  add-videos.ts  (1 functions)
  get-folder-videos.ts  (1 functions)
  moveVideoToFolder.ts  (1 functions)
  remove-videos.ts  (1 functions)
apps/web/actions/notifications/
  mark-as-read.ts  (1 functions)
  update-preferences.ts  (1 functions)
apps/web/actions/organization/
  check-domain.ts  (1 functions)
  create-space.ts  (1 functions)
  delete-space.ts  (1 functions)
  domain-utils.ts  (6 functions)
  get-organization-sso-data.ts  (1 functions)
  get-subscription-details.ts  (1 functions)
  manage-billing.ts  (1 functions)
  remove-domain.ts  (1 functions)
  remove-invite.ts  (1 functions)
  remove-member.ts  (1 functions)
  send-invites.ts  (1 functions)
  settings.ts  (1 functions)
  toggle-pro-seat.ts  (1 functions)
  update-details.ts  (1 functions)
  update-domain.ts  (1 functions)
  update-seat-quantity.ts  (4 functions)
  update-space.ts  (1 functions)
  upload-space-icon.ts  (1 functions)
apps/web/actions/organizations/
  add-videos.ts  (1 functions)
  get-organization-videos.ts  (1 functions)
  remove-videos.ts  (1 functions)
apps/web/actions/spaces/
  add-videos.ts  (1 functions)
  get-space-videos.ts  (1 functions)
  get-user-videos.ts  (1 functions)
  remove-videos.ts  (1 functions)
apps/web/actions/video/
  create-for-processing.ts  (1 functions)
  retry-processing.ts  (2 functions)
  trigger-processing.ts  (1 functions)
  upload.ts  (6 functions)
apps/web/actions/videos/
  delete-comment.ts  (1 functions)
  download.ts  (1 functions)
  edit-date.ts  (1 functions)
  edit-title.ts  (1 functions)
  edit-transcript.ts  (2 functions)
  get-analytics.ts  (7 functions)
  get-available-translations.ts  (1 functions)
  get-og-image.tsx  (2 functions)
  get-status.ts  (1 functions)
  get-transcript.ts  (1 functions)
  new-comment.ts  (1 functions)
  password.ts  (3 functions)
  settings.ts  (1 functions)
  translate-transcript.ts  (2 functions)
  translation-languages.ts
apps/web/app/
  layout.tsx
  not-found.tsx  (1 functions)
  robots.ts  (1 functions)
  sitemap.ts  (2 functions)
  themeScript.js  (1 functions)
apps/web/app/(docs)/
  layout.tsx  (1 functions)
apps/web/app/(docs)/docs/
  docs-config.ts  (3 functions)
  layout.tsx  (1 functions)
apps/web/app/(docs)/docs/[[...slug]]/
  page.tsx  (2 functions)
apps/web/app/(docs)/docs/_components/
  DocsBreadcrumbs.tsx  (1 functions)
  DocsHeader.tsx  (5 functions)
  DocsMobileMenu.tsx  (3 functions)
  DocsPrevNext.tsx  (1 functions)
  DocsSearch.tsx  (5 functions)
  DocsSidebar.tsx  (2 functions)
  DocsTableOfContents.tsx  (1 functions)
apps/web/app/(org)/
  layout.tsx  (1 functions)
apps/web/app/(org)/dashboard/
  Contexts.tsx  (6 functions)
  dashboard-data.ts  (1 functions)
  layout.tsx  (1 functions)
  loading.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/_components/
  Avatar.tsx  (1 functions)
  Confetti.tsx  (1 functions)
  ConfirmationDialog.tsx  (1 functions)
  DashboardInner.tsx  (1 functions)
  MobileTab.tsx  (3 functions)
  actions.ts  (1 functions)
apps/web/app/(org)/dashboard/_components/AnimatedIcons/
  ArrowUp.tsx
  Cap.tsx
  ChartLine.tsx
  Chat.tsx
  Clap.tsx
  Code.tsx
  Cog.tsx
  Download.tsx
  Home.tsx
  Import.tsx
  Layers.tsx
  Logout.tsx
  Reaction.tsx
  Record.tsx
  Refer.tsx  (2 functions)
  Settings.tsx
  index.ts
apps/web/app/(org)/dashboard/_components/Navbar/
  CapAIBox.tsx  (1 functions)
  CapAIDialog.tsx  (1 functions)
  Desktop.tsx  (2 functions)
  Items.tsx  (3 functions)
  MemberAvatars.tsx  (1 functions)
  Mobile.tsx  (1 functions)
  SpaceDialog.tsx  (3 functions)
  SpacesList.tsx  (8 functions)
  Top.tsx  (3 functions)
  server.ts  (3 functions)
apps/web/app/(org)/dashboard/_components/Notifications/
  Filter.ts  (1 functions)
  FilterTabs.tsx  (2 functions)
  NotificationFooter.tsx  (1 functions)
  NotificationHeader.tsx  (1 functions)
  NotificationItem.tsx  (3 functions)
  SettingsDropdown.tsx  (2 functions)
  Skeleton.tsx  (2 functions)
  index.tsx  (1 functions)
apps/web/app/(org)/dashboard/analytics/
  data.ts  (28 functions)
  page.tsx  (1 functions)
  types.ts
apps/web/app/(org)/dashboard/analytics/components/
  AnalyticsDashboard.tsx  (1 functions)
  ChartArea.tsx  (2 functions)
  Header.tsx  (8 functions)
  OtherStatBox.tsx  (1 functions)
  OtherStats.tsx  (8 functions)
  StatsChart.tsx  (5 functions)
  TableCard.tsx  (9 functions)
  VideoComponents.tsx  (4 functions)
  VideoFilters.tsx  (1 functions)
  VideosPicker.tsx  (1 functions)
apps/web/app/(org)/dashboard/caps/
  Caps.tsx  (5 functions)
  UploadingContext.tsx  (5 functions)
  loading.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/caps/components/
  CapPagination.tsx  (1 functions)
  EmptyCapState.tsx  (1 functions)
  Folder.tsx  (5 functions)
  Folders.tsx
  FoldersDropdown.tsx  (1 functions)
  ImportLoomButton.tsx  (3 functions)
  NewFolderDialog.tsx  (1 functions)
  PasswordDialog.tsx  (1 functions)
  SelectedCapsBar.tsx  (2 functions)
  SettingsDialog.tsx  (3 functions)
  SharingDialog.tsx  (7 functions)
  UploadCapButton.tsx  (2 functions)
  UploadPlaceholderCard.tsx  (2 functions)
  index.ts
  sendProgressUpdate.ts  (1 functions)
apps/web/app/(org)/dashboard/caps/components/CapCard/
  CapCard.tsx  (12 functions)
  CapCardAnalytics.tsx  (2 functions)
  CapCardButton.tsx  (1 functions)
  CapCardContent.tsx  (8 functions)
apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/
  CameraPreviewWindow.tsx  (7 functions)
  CameraSelector.tsx  (3 functions)
  HowItWorksButton.tsx  (1 functions)
  HowItWorksPanel.tsx  (1 functions)
  InProgressRecordingBar.tsx  (12 functions)
  MicrophoneSelector.tsx  (3 functions)
  RecordingButton.tsx  (2 functions)
  RecordingModeSelector.tsx  (1 functions)
  SettingsButton.tsx  (1 functions)
  SettingsPanel.tsx  (1 functions)
  SystemAudioToggle.tsx  (1 functions)
  instant-mp4-uploader.ts  (41 functions)
  local-recording-backup.ts  (3 functions)
  recording-conversion.ts  (7 functions)
  recording-spool-fallback.ts  (1 functions)
  recording-spool.ts  (28 functions)
  recording-upload.ts  (1 functions)
  recovered-recording-cache.ts  (3 functions)
  useCameraDevices.ts  (2 functions)
  useDevicePreferences.ts  (5 functions)
  useDialogInteractions.ts  (7 functions)
  useMediaPermission.ts  (1 functions)
  useMediaRecorderSetup.ts  (1 functions)
  useMicrophoneDevices.ts  (2 functions)
  useRecordingTimer.ts  (1 functions)
  useStreamManagement.ts  (2 functions)
  useSurfaceDetection.ts  (3 functions)
  useWebRecorder.ts  (9 functions)
  web-recorder-constants.ts
  web-recorder-dialog-header.tsx  (1 functions)
  web-recorder-dialog.tsx  (6 functions)
  web-recorder-types.ts
  web-recorder-utils.ts  (9 functions)
apps/web/app/(org)/dashboard/caps/record/
  RecordVideoPage.tsx  (4 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/
  DevelopersContext.tsx  (2 functions)
  developer-data.ts  (4 functions)
  layout.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/_components/
  ApiKeyDisplay.tsx  (2 functions)
  AppCard.tsx  (1 functions)
  CreateAppDialog.tsx  (2 functions)
  CreditTransactionTable.tsx  (1 functions)
  DeveloperSidebarContent.tsx  (2 functions)
  DeveloperSidebarRegistrar.tsx  (1 functions)
  DeveloperThemeForcer.tsx  (1 functions)
  DomainRow.tsx  (1 functions)
  EnvironmentBadge.tsx  (1 functions)
  StatBox.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/apps/
  AppsListClient.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/apps/[appId]/
  layout.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/apps/[appId]/api-keys/
  ApiKeysClient.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/apps/[appId]/domains/
  DomainsClient.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/apps/[appId]/settings/
  AppSettingsClient.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/apps/[appId]/videos/
  VideosClient.tsx  (3 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/credits/
  CreditsClient.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/developers/usage/
  UsageClient.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/folder/[id]/
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/folder/[id]/components/
  BreadcrumbItem.tsx  (4 functions)
  ClientCapCard.tsx  (5 functions)
  ClientMyCapsLink.tsx  (3 functions)
  FolderVideosSection.tsx  (2 functions)
  NewSubfolderButton.tsx  (1 functions)
  SubfolderDialog.tsx  (1 functions)
  index.ts
apps/web/app/(org)/dashboard/import/
  ImportPage.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/import/file/
  ImportFilePage.tsx  (8 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/import/loom/
  ImportLoomPage.tsx  (2 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/refer/
  ReferClient.tsx  (1 functions)
  loading.tsx  (1 functions)
  page.tsx  (2 functions)
apps/web/app/(org)/dashboard/settings/account/
  Settings.tsx  (4 functions)
  loading.tsx  (1 functions)
  page.tsx  (1 functions)
  server.ts  (1 functions)
apps/web/app/(org)/dashboard/settings/account/components/
  ProfileImage.tsx  (4 functions)
apps/web/app/(org)/dashboard/settings/organization/
  GeneralPage.tsx  (1 functions)
  layout.tsx  (1 functions)
  loading.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/settings/organization/_components/
  SettingsNav.tsx  (1 functions)
apps/web/app/(org)/dashboard/settings/organization/billing/
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/settings/organization/components/
  AccessEmailDomain.tsx  (2 functions)
  BillingSummaryCard.tsx  (1 functions)
  CapSettingsCard.tsx  (3 functions)
  CustomDomain.tsx  (2 functions)
  DeleteOrg.tsx  (1 functions)
  DeleteOrgDialog.tsx  (1 functions)
  InviteDialog.tsx  (3 functions)
  MembersCard.tsx  (3 functions)
  OrgName.tsx  (2 functions)
  OrganizationDetailsCard.tsx  (1 functions)
  OrganizationIcon.tsx  (1 functions)
  SeatManagementCard.tsx  (2 functions)
apps/web/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/
  CustomDomainDialog.tsx  (5 functions)
  DomainStep.tsx  (2 functions)
  Stepper.tsx  (1 functions)
  SubscribeContent.tsx  (1 functions)
  SuccessStep.tsx  (1 functions)
  VerifyStep.tsx  (5 functions)
  types.ts
apps/web/app/(org)/dashboard/settings/organization/members/
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/settings/organization/preferences/
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/settings/workspace/
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/spaces/[spaceId]/
  SharedCaps.tsx  (2 functions)
  actions.ts  (5 functions)
  loading.tsx  (1 functions)
  page.tsx  (4 functions)
apps/web/app/(org)/dashboard/spaces/[spaceId]/components/
  AddVideosDialog.tsx  (1 functions)
  AddVideosDialogBase.tsx  (2 functions)
  AddVideosToOrganizationDialog.tsx  (1 functions)
  EmptySharedCapState.tsx  (1 functions)
  MemberSelect.tsx  (3 functions)
  MembersDialog.tsx  (1 functions)
  MembersIndicator.tsx  (2 functions)
  OrganizationIndicator.tsx  (1 functions)
  SharedCapCard.tsx  (1 functions)
  VideoCard.tsx
  VirtualizedVideoGrid.tsx  (2 functions)
apps/web/app/(org)/dashboard/spaces/[spaceId]/folder/[folderId]/
  AddVideosButton.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/dashboard/spaces/browse/
  loading.tsx  (1 functions)
  page.tsx  (3 functions)
apps/web/app/(org)/invite/[inviteId]/
  InviteAccept.tsx  (3 functions)
  page.tsx  (3 functions)
apps/web/app/(org)/login/
  form.tsx  (6 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/onboarding/
  layout.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/onboarding/[...steps]/
  layout.tsx  (2 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/onboarding/components/
  Base.tsx  (1 functions)
  Bottom.tsx  (1 functions)
  CustomDomainPage.tsx  (2 functions)
  DownloadPage.tsx  (1 functions)
  InviteTeamPage.tsx  (5 functions)
  OrganizationSetupPage.tsx  (3 functions)
  Stepper.tsx  (2 functions)
  WelcomePage.tsx  (2 functions)
apps/web/app/(org)/signup/
  form.tsx  (6 functions)
  page.tsx  (1 functions)
apps/web/app/(org)/verify-otp/
  form.tsx  (4 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/
  Footer.tsx  (1 functions)
  Navbar.tsx  (3 functions)
  layout.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/async-video-code-reviews/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/best-screen-recorder/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/developer-documentation-videos/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/free-screen-recorder/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/hipaa-compliant-screen-recording/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/how-to-screen-record/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/loom-alternative/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/mac-screen-recording-with-audio/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/obs-alternative/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/open-source-screen-recorder/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/record-screen/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/screen-recorder/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/screen-recorder-mac/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/screen-recorder-windows/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/screen-recording/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/screen-recording-software/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/self-hosted-screen-recording/
  page.tsx  (1 functions)
apps/web/app/(site)/(seo)/solutions/agencies/
  page.tsx  (3 functions)
apps/web/app/(site)/(seo)/solutions/daily-standup-software/
  page.tsx
apps/web/app/(site)/(seo)/solutions/employee-onboarding-platform/
  page.tsx
apps/web/app/(site)/(seo)/solutions/online-classroom-tools/
  page.tsx
apps/web/app/(site)/(seo)/solutions/remote-team-collaboration/
  page.tsx
apps/web/app/(site)/(seo)/video-recording-software/
  page.tsx  (1 functions)
apps/web/app/(site)/[slug]/
  layout.tsx  (1 functions)
  page.tsx  (2 functions)
apps/web/app/(site)/about/
  page.tsx  (1 functions)
apps/web/app/(site)/blog/
  page.tsx  (1 functions)
apps/web/app/(site)/blog/[slug]/
  page.tsx  (2 functions)
apps/web/app/(site)/blog/_components/
  Share.tsx  (1 functions)
apps/web/app/(site)/deactivate-license/
  page.tsx  (1 functions)
apps/web/app/(site)/download/
  page.tsx  (1 functions)
apps/web/app/(site)/download/[platform]/
  route.ts  (3 functions)
apps/web/app/(site)/download/versions/
  page.tsx  (5 functions)
apps/web/app/(site)/faq/
  page.tsx  (1 functions)
apps/web/app/(site)/features/
  FeaturesPage.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/features/instant-mode/
  InstantModePage.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/features/studio-mode/
  StudioModePage.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/home/
  page.tsx  (1 functions)
apps/web/app/(site)/oss-friends/
  loading.tsx  (1 functions)
  page.tsx  (2 functions)
apps/web/app/(site)/pricing/
  page.tsx  (1 functions)
apps/web/app/(site)/privacy/
  page.tsx  (1 functions)
apps/web/app/(site)/self-hosting/
  SelfHostingPage.tsx  (2 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/student-discount/
  page.tsx  (1 functions)
apps/web/app/(site)/terms/
  page.tsx  (1 functions)
apps/web/app/(site)/testimonials/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/
  PageContent.tsx  (1 functions)
  layout.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/
  layout.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/[conversionPath]/
  page.tsx  (3 functions)
apps/web/app/(site)/tools/convert/avi-to-mp4/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/mkv-to-mp4/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/mov-to-mp4/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/mp4-to-gif/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/mp4-to-mp3/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/mp4-to-webm/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/convert/webm-to-mp4/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/loom-downloader/
  page.tsx  (1 functions)
apps/web/app/(site)/tools/trim/
  layout.tsx  (1 functions)
  metadata.ts
  page.tsx  (1 functions)
apps/web/app/(site)/tools/video-speed-controller/
  layout.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/Layout/
  AuthContext.tsx  (3 functions)
  GTag.tsx  (2 functions)
  MessengerWidget.tsx  (18 functions)
  MetaPixel.tsx  (3 functions)
  PosthogIdentify.tsx  (2 functions)
  PosthogPageView.tsx  (2 functions)
  PurchaseTracker.tsx  (1 functions)
  StripeContext.tsx  (2 functions)
  current-user.ts
  devtoolsServer.ts  (3 functions)
  features.ts  (3 functions)
  providers.tsx  (7 functions)
apps/web/app/admin/
  AdminPanel.tsx  (14 functions)
  page.tsx  (1 functions)
apps/web/app/admin/replace-video/
  ReplaceVideoPanel.tsx  (2 functions)
  page.tsx  (1 functions)
apps/web/app/api/
  utils.ts  (2 functions)
apps/web/app/api/[[...route]]/
  route.ts
apps/web/app/api/analytics/
  route.ts  (2 functions)
apps/web/app/api/analytics/track/
  route.ts  (3 functions)
apps/web/app/api/auth/[...nextauth]/
  route.ts
apps/web/app/api/changelog/
  route.ts  (2 functions)
apps/web/app/api/changelog/status/
  route.ts  (2 functions)
apps/web/app/api/cron/developer-storage/
  route.ts  (1 functions)
apps/web/app/api/dashboard/analytics/
  route.ts  (1 functions)
apps/web/app/api/desktop/[...route]/
  root.ts  (1 functions)
  route.ts
  s3Config.ts
  session.ts  (2 functions)
  video.ts
apps/web/app/api/developer/credits/checkout/
  route.ts
apps/web/app/api/developer/sdk/v1/[...route]/
  route.ts
  upload.ts
  video-create.ts
apps/web/app/api/developer/v1/[...route]/
  route.ts
  usage.ts
  videos.ts
apps/web/app/api/download/
  route.ts  (1 functions)
apps/web/app/api/email/new-comment/
  route.ts  (1 functions)
apps/web/app/api/erpc/
  route.ts  (2 functions)
apps/web/app/api/invite/accept/
  route.ts  (1 functions)
apps/web/app/api/invite/decline/
  route.ts  (1 functions)
apps/web/app/api/notifications/
  route.ts  (1 functions)
apps/web/app/api/notifications/preferences/
  route.ts  (1 functions)
apps/web/app/api/playlist/
  route.ts  (4 functions)
apps/web/app/api/releases/tauri/[version]/[target]/[arch]/
  route.ts  (1 functions)
apps/web/app/api/settings/billing/guest-checkout/
  route.ts  (1 functions)
apps/web/app/api/settings/billing/manage/
  route.ts  (1 functions)
apps/web/app/api/settings/billing/subscribe/
  route.ts  (1 functions)
apps/web/app/api/settings/billing/usage/
  GET.ts
  route.ts  (1 functions)
apps/web/app/api/settings/user/name/
  route.ts  (1 functions)
apps/web/app/api/status/
  route.ts  (1 functions)
apps/web/app/api/thumbnail/
  route.ts  (1 functions)
apps/web/app/api/tools/loom-download/
  route.ts  (10 functions)
apps/web/app/api/upload/
  utils.ts  (1 functions)
apps/web/app/api/upload/[...route]/
  multipart-utils.ts  (3 functions)
  multipart.ts
  recording-complete.ts
  route.ts
  signed.ts
apps/web/app/api/video/ai/
  route.ts  (1 functions)
apps/web/app/api/video/comment/
  route.ts  (3 functions)
apps/web/app/api/video/comment/delete/
  route.ts  (1 functions)
apps/web/app/api/video/delete/
  route.ts
apps/web/app/api/video/domain-info/
  route.ts  (1 functions)
apps/web/app/api/video/metadata/
  route.ts  (1 functions)
apps/web/app/api/video/og/
  route.tsx  (1 functions)
apps/web/app/api/video/transcribe/status/
  route.ts  (1 functions)
apps/web/app/api/videos/[videoId]/retry-ai/
  route.ts  (1 functions)
apps/web/app/api/videos/[videoId]/retry-transcription/
  route.ts  (1 functions)
apps/web/app/api/webhooks/media-server/progress/
  route.ts  (3 functions)
apps/web/app/api/webhooks/stripe/
  route.ts  (3 functions)
apps/web/app/dev/[videoId]/
  page.tsx  (1 functions)
apps/web/app/embed/
  page.tsx  (1 functions)
apps/web/app/embed/[videoId]/
  page.tsx  (3 functions)
apps/web/app/embed/[videoId]/_components/
  EmbedVideo.tsx  (3 functions)
  PasswordOverlay.tsx  (1 functions)
apps/web/app/lib/
  compose-refs.ts  (3 functions)
  utils.ts  (1 functions)
apps/web/app/messenger/
  page.tsx  (3 functions)
apps/web/app/messenger/[id]/
  ChatWindow.tsx  (8 functions)
  page.tsx  (1 functions)
apps/web/app/s/
  _loading.tsx  (1 functions)
  page.tsx  (1 functions)
apps/web/app/s/[videoId]/
  Share.tsx  (9 functions)
  page.tsx  (9 functions)
  types.ts
apps/web/app/s/[videoId]/_components/
  AudioPlayer.tsx
  AuthOverlay.tsx  (3 functions)
  CapVideoPlayer.tsx  (13 functions)
  CaptionContext.tsx  (3 functions)
  CommentStamp.tsx  (1 functions)
  HLSVideoPlayer.tsx  (13 functions)
  OtpForm.tsx  (4 functions)
  PasswordOverlay.tsx  (1 functions)
  ProgressCircle.tsx  (8 functions)
  ShareHeader.tsx  (11 functions)
  ShareVideo.tsx  (2 functions)
  Sidebar.tsx  (2 functions)
  SummaryChapters.tsx  (1 functions)
  Toolbar.tsx  (6 functions)
  playback-source.ts  (9 functions)
apps/web/app/s/[videoId]/_components/tabs/
  Settings.tsx  (2 functions)
  Summary.tsx  (5 functions)
  Transcript.tsx  (17 functions)
apps/web/app/s/[videoId]/_components/tabs/Activity/
  Analytics.tsx  (2 functions)
  Comment.tsx  (2 functions)
  CommentInput.tsx  (3 functions)
  Comments.tsx  (4 functions)
  EmptyState.tsx  (1 functions)
  index.tsx
  utils.ts  (2 functions)
apps/web/app/s/[videoId]/_components/utils/
  transcript-utils.ts  (8 functions)
apps/web/app/s/[videoId]/_components/video/
  badge.tsx  (1 functions)
  button.tsx
  media-player.tsx  (62 functions)
  select.tsx
  slider.tsx
  tooltip.tsx
apps/web/app/utils/
  analytics.ts  (3 functions)
  auth.ts
apps/web/components/
  AnimalAvatar.tsx  (2 functions)
  BentoScript.tsx  (1 functions)
  CommercialGetStarted.tsx  (2 functions)
  EmptyState.tsx  (1 functions)
  FileInput.tsx  (7 functions)
  ReadyToGetStarted.tsx  (1 functions)
  SignedImageUrl.tsx  (1 functions)
  SonnerToastProvider.tsx  (2 functions)
  Tooltip.tsx  (1 functions)
  UpgradeModal.tsx  (1 functions)
  UsageButton.tsx
  VideoThumbnail.tsx  (3 functions)
  index.ts
  mdx-components.tsx  (1 functions)
  mdx.tsx  (9 functions)
  theme-toggle-icon.tsx  (1 functions)
apps/web/components/blog/
  AuthorByline.tsx  (1 functions)
  BlogTemplate.tsx  (3 functions)
  RecordScreenMacStructuredData.tsx  (3 functions)
apps/web/components/features/
  FeaturePage.tsx  (1 functions)
apps/web/components/forms/
  NewOrganization.tsx  (1 functions)
  server.ts  (1 functions)
apps/web/components/icons/
  QuestionMarkIcon.tsx  (1 functions)
apps/web/components/pages/
  AboutPage.tsx  (1 functions)
  DocsPage.tsx  (1 functions)
  DownloadPage.tsx  (1 functions)
  FaqPage.tsx  (1 functions)
  LicenseDeactivationPage.tsx  (2 functions)
  PricingPage.tsx  (2 functions)
  StudentDiscountPage.tsx  (2 functions)
  TermsPage.tsx  (1 functions)
  TestimonialsPage.tsx
  UpdatesPage.tsx  (1 functions)
apps/web/components/pages/HomePage/
  Faq.tsx  (2 functions)
  Features.tsx  (2 functions)
  Header.tsx  (2 functions)
  HeaderBg.tsx  (1 functions)
  HomePageSchema.tsx  (2 functions)
  InstantModeDetail.tsx  (3 functions)
  LeftBlueHue.tsx  (1 functions)
  LeftLight.tsx  (1 functions)
  PowerfulFeaturesSVG.tsx  (1 functions)
  RecordingModePicker.tsx  (4 functions)
  RecordingModes.tsx  (2 functions)
  ScreenshotModeDetail.tsx  (6 functions)
  StudioModeDetail.tsx  (6 functions)
  Testimonials.tsx
  VideoModal.tsx  (1 functions)
  index.tsx  (1 functions)
apps/web/components/pages/HomePage/Pricing/
  CommercialArt.tsx
  CommercialCard.tsx  (4 functions)
  EnterpriseArt.tsx
  EnterpriseCard.tsx  (2 functions)
  ProArt.tsx
  ProCard.tsx  (3 functions)
  QuantityButton.tsx  (1 functions)
  index.tsx  (1 functions)
apps/web/components/pages/_components/
  ComparePlans.tsx  (9 functions)
  FeatureCard.tsx  (1 functions)
  LogoSection.tsx  (1 functions)
  UpgradeToPro.tsx  (1 functions)
apps/web/components/pages/seo/
  AgenciesPage.tsx  (3 functions)
  AsyncVideoCodeReviewsPage.tsx  (1 functions)
  BestScreenRecorderPage.tsx  (1 functions)
  DailyStandupSoftwarePage.tsx  (2 functions)
  DeveloperDocumentationVideosPage.tsx  (1 functions)
  EmployeeOnboardingPlatformPage.tsx  (2 functions)
  FreeScreenRecorderPage.tsx  (1 functions)
  HipaaCompliantScreenRecordingPage.tsx  (1 functions)
  HowToScreenRecordPage.tsx  (1 functions)
  LoomAlternativePage.tsx  (2 functions)
  MacScreenRecordingWithAudioPage.tsx  (1 functions)
  ObsAlternativePage.tsx  (1 functions)
  OnlineClassroomToolsPage.tsx  (2 functions)
  OpenSourceScreenRecorderPage.tsx  (1 functions)
  RecordScreenPage.tsx  (1 functions)
  RemoteTeamCollaborationPage.tsx  (2 functions)
  ScreenRecordMacPage.tsx  (2 functions)
  ScreenRecordWindowsPage.tsx  (3 functions)
  ScreenRecorderPage.tsx  (1 functions)
  ScreenRecordingPage.tsx  (1 functions)
  ScreenRecordingSoftwarePage.tsx  (2 functions)
  SelfHostedScreenRecordingPage.tsx  (1 functions)
  VideoRecordingSoftwarePage.tsx  (1 functions)
apps/web/components/seo/
  ComparisonSlider.tsx  (6 functions)
  SeoPageTemplate.tsx  (4 functions)
  types.ts
apps/web/components/text/
  SimplePlans.tsx  (1 functions)
apps/web/components/tools/
  LoomDownloader.tsx  (6 functions)
  MediaFormatConverter.tsx  (25 functions)
  SpeedController.tsx  (14 functions)
  ToolsPageTemplate.tsx  (4 functions)
  TrimmingTool.tsx  (24 functions)
  content.ts
  types.ts
apps/web/components/ui/
  LogoMarquee.tsx  (1 functions)
  MobileMenu.tsx  (1 functions)
  Testimonials.tsx  (1 functions)
  TextReveal.tsx  (2 functions)
  chart.tsx  (2 functions)
  popover.tsx  (4 functions)
apps/web/content/blog-content/
  record-screen-mac-system-audio.tsx
  windows-11-record-screen-system-audio-no-stereo-mix.tsx
apps/web/data/
  homepage-copy.ts
  testimonials.ts
apps/web/hooks/
  use-transcript.ts  (2 functions)
  useDetectPlatform.ts  (2 functions)
apps/web/lib/
  EffectRuntime.ts  (2 functions)
  Notification.ts  (4 functions)
  Rpcs.ts  (1 functions)
  anonymous-names.ts  (3 functions)
  audio-enhance.ts  (2 functions)
  audio-extract.ts  (6 functions)
  developer-credits.ts  (1 functions)
  developer-key-hash.ts  (2 functions)
  effect-react-query.ts  (2 functions)
  folder.ts
  gemini-client.ts  (1 functions)
  generate-ai.ts  (1 functions)
  groq-client.ts  (1 functions)
  media-client.js
  media-client.ts  (10 functions)
  sanitizeFile.ts  (1 functions)
  seo-metadata.ts  (1 functions)
  seo-pages.ts  (1 functions)
  server.ts  (3 functions)
  tracing.js
  tracing.ts
  transcribe-utils.ts  (3 functions)
  transcribe.ts  (1 functions)
  utils.ts  (2 functions)
  video-convert.ts  (11 functions)
  video-processing.ts  (4 functions)
apps/web/lib/Queries/
  Analytics.ts  (1 functions)
apps/web/lib/Requests/
  AnalyticsRequest.ts
  ThumbnailRequest.ts  (1 functions)
apps/web/lib/features/
  index.ts
  transform.ts  (2 functions)
  types.ts
apps/web/lib/messenger/
  agent.ts  (9 functions)
  constants.ts
  data.ts  (8 functions)
  supermemory.ts  (9 functions)
apps/web/public/
  gif.worker.js  (24 functions)
apps/web/tools/
  compress-images.js  (5 functions)
apps/web/types/
  gif.js.d.ts
apps/web/utils/
  authors.ts  (2 functions)
  blog-registry.ts  (3 functions)
  blog.ts  (9 functions)
  changelog.ts  (5 functions)
  cors.ts  (2 functions)
  desktop.ts  (2 functions)
  docs.ts  (6 functions)
  effect.ts  (1 functions)
  flags.ts  (1 functions)
  getBootstrapData.ts
  github.ts  (2 functions)
  gradients.ts  (2 functions)
  helpers.ts  (3 functions)
  organization.ts  (2 functions)
  platform.tsx  (5 functions)
  public-env.tsx  (2 functions)
  readTime.ts  (1 functions)
  releases.ts  (4 functions)
  sql.ts  (1 functions)
  web-api.ts  (1 functions)
  web-schema.ts  (10 functions)
  zod.ts
apps/web/utils/video/ffmpeg/
  helpers.ts  (2 functions)
apps/web/workflows/
  generate-ai.ts  (14 functions)
  import-loom-video.ts  (13 functions)
  process-video.ts  (12 functions)
  transcribe.ts  (15 functions)
crates/api/src/
  lib.rs
crates/audio/src/
  audio_data.rs  (5 functions)
  calibration_store.rs  (11 functions)
  latency.rs  (59 functions)
  lib.rs  (2 functions)
  main.rs  (3 functions)
  renderer.rs  (3 functions)
  sync_analysis.rs  (11 functions)
crates/audio/src/bin/
  analyze.rs  (1 functions)
  macos-audio-capture.rs  (2 functions)
crates/camera-avfoundation/examples/
  cli.rs  (4 functions)
crates/camera-avfoundation/src/
  lib.rs  (9 functions)
crates/camera-directshow/examples/
  cli.rs  (2 functions)
crates/camera-directshow/src/
  lib.rs  (76 functions)
crates/camera-ffmpeg/examples/
  cli.rs  (3 functions)
crates/camera-ffmpeg/src/
  lib.rs
  macos.rs  (2 functions)
  windows.rs  (11 functions)
crates/camera-mediafoundation/examples/
  cli.rs  (4 functions)
crates/camera-mediafoundation/src/
  lib.rs  (26 functions)
crates/camera-windows/examples/
  cli.rs  (3 functions)
crates/camera-windows/src/
  lib.rs  (42 functions)
crates/camera/examples/
  cli.rs  (3 functions)
crates/camera/src/
  lib.rs  (19 functions)
  macos.rs  (11 functions)
  windows.rs  (7 functions)
crates/cap-test/src/
  lib.rs
  main.rs  (11 functions)
crates/cap-test/src/config/
  loader.rs  (6 functions)
  mod.rs
  types.rs  (26 functions)
crates/cap-test/src/discovery/
  audio.rs  (5 functions)
  cameras.rs  (4 functions)
  displays.rs  (2 functions)
  mod.rs  (5 functions)
crates/cap-test/src/matrix/
  generator.rs  (8 functions)
  mod.rs
  runner.rs  (11 functions)
crates/cap-test/src/results/
  json.rs  (3 functions)
  mod.rs
  summary.rs  (2 functions)
  types.rs  (15 functions)
crates/cap-test/src/suites/
  encoding.rs  (4 functions)
  mod.rs  (6 functions)
  performance.rs  (12 functions)
  playback.rs  (3 functions)
  recording.rs  (9 functions)
  scenarios.rs  (17 functions)
  sync.rs  (1 functions)
  validate.rs  (9 functions)
crates/cpal-ffmpeg/src/
  lib.rs  (1 functions)
crates/cursor-capture/src/
  lib.rs
  main.rs  (1 functions)
  position.rs  (18 functions)
crates/cursor-info/examples/
  cli.rs  (2 functions)
crates/cursor-info/src/
  lib.rs  (5 functions)
  macos.rs  (3 functions)
  windows.rs  (5 functions)
crates/editor/examples/
  cli.rs  (1 functions)
  decode-benchmark.rs  (9 functions)
  playback-pipeline-benchmark.rs  (8 functions)
crates/editor/src/
  audio.rs  (38 functions)
  editor.rs  (6 functions)
  editor_instance.rs  (13 functions)
  lib.rs
  playback.rs  (13 functions)
  segments.rs  (1 functions)
crates/enc-avfoundation/src/
  lib.rs
  mp4.rs  (81 functions)
crates/enc-ffmpeg/src/
  base.rs  (5 functions)
  lib.rs
  remux.rs  (28 functions)
crates/enc-ffmpeg/src/audio/
  aac.rs  (6 functions)
  audio_encoder.rs  (1 functions)
  base.rs  (3 functions)
  buffered_resampler.rs  (19 functions)
  mod.rs
  opus.rs  (10 functions)
crates/enc-ffmpeg/src/mux/
  dash_audio.rs  (24 functions)
  fragmented_audio.rs  (5 functions)
  mod.rs
  mov.rs  (4 functions)
  mp4.rs  (9 functions)
  ogg.rs  (5 functions)
  segmented_audio.rs  (13 functions)
  segmented_stream.rs  (33 functions)
crates/enc-ffmpeg/src/video/
  h264.rs  (24 functions)
  hevc.rs  (16 functions)
  mod.rs
  prores.rs  (7 functions)
crates/enc-gif/src/
  lib.rs  (9 functions)
crates/enc-mediafoundation/examples/
  cli.rs  (9 functions)
crates/enc-mediafoundation/src/
  d3d.rs  (5 functions)
  lib.rs
  media.rs  (4 functions)
  mft.rs  (6 functions)
crates/enc-mediafoundation/src/video/
  h264.rs  (20 functions)
  hevc.rs  (9 functions)
  mod.rs
  video_processor.rs  (5 functions)
crates/export/examples/
  export-benchmark-runner.rs  (22 functions)
  export-cli.rs  (2 functions)
  export_startup_time.rs  (1 functions)
crates/export/src/
  gif.rs  (2 functions)
  lib.rs  (7 functions)
  mov.rs  (2 functions)
  mp4.rs  (17 functions)
crates/export/tests/
  export_benchmark.rs  (4 functions)
  long_video_export.rs  (4 functions)
  real_recording_regression.rs  (5 functions)
crates/fail/src/
  lib.rs  (3 functions)
crates/ffmpeg-hw-device/src/
  lib.rs  (5 functions)
crates/flags/src/
  lib.rs
crates/frame-converter/
  build.rs  (1 functions)
crates/frame-converter/examples/
  benchmark.rs  (5 functions)
crates/frame-converter/src/
  d3d11.rs  (35 functions)
  frame_pool.rs  (7 functions)
  lib.rs  (14 functions)
  pool.rs  (16 functions)
  swscale.rs  (9 functions)
  videotoolbox.rs  (12 functions)
crates/gpu-converters/src/
  lib.rs  (1 functions)
  util.rs  (2 functions)
  uyvy.rs  (1 functions)
  yuyv.rs  (1 functions)
crates/gpu-converters/src/bgra_rgba/
  mod.rs  (2 functions)
crates/gpu-converters/src/nv12_rgba/
  mod.rs  (2 functions)
crates/gpu-converters/src/uyvy_nv12/
  mod.rs  (2 functions)
crates/gpu-converters/src/uyvy_rgba/
  mod.rs  (2 functions)
crates/gpu-converters/src/yuyv_nv12/
  mod.rs  (2 functions)
crates/gpu-converters/src/yuyv_rgba/
  mod.rs  (2 functions)
crates/media-info/src/
  lib.rs  (30 functions)
crates/media/src/
  lib.rs  (1 functions)
crates/mediafoundation-ffmpeg/examples/
  usage.rs  (4 functions)
crates/mediafoundation-ffmpeg/src/
  audio.rs  (1 functions)
  h264.rs  (9 functions)
  lib.rs
crates/mediafoundation-utils/src/
  lib.rs  (6 functions)
crates/project/src/
  configuration.rs  (53 functions)
  cursor.rs  (11 functions)
  keyboard.rs  (26 functions)
  lib.rs  (1 functions)
  meta.rs  (29 functions)
crates/recording/examples/
  camera-benchmark.rs  (4 functions)
  camera-writer-repro.rs  (9 functions)
  camera.rs  (2 functions)
  encoding-benchmark.rs  (10 functions)
  memory-leak-detector.rs  (7 functions)
  playback-test-runner.rs  (15 functions)
  real-device-test-runner.rs  (33 functions)
  recording-benchmark.rs  (4 functions)
  recording-cli.rs  (1 functions)
  synthetic-test-runner.rs  (14 functions)
crates/recording/src/
  benchmark.rs  (34 functions)
  capture_pipeline.rs  (9 functions)
  cursor.rs  (6 functions)
  diagnostics.rs  (14 functions)
  instant_recording.rs  (23 functions)
  lib.rs  (5 functions)
  output_validation.rs  (1 functions)
  recovery.rs  (27 functions)
  resolution_limits.rs  (3 functions)
  screenshot.rs  (23 functions)
  studio_recording.rs  (55 functions)
  sync_calibration.rs  (5 functions)
crates/recording/src/feeds/
  camera.rs  (17 functions)
  microphone.rs  (19 functions)
  mod.rs
crates/recording/src/fragmentation/
  manifest.rs  (6 functions)
  mod.rs  (14 functions)
crates/recording/src/output_pipeline/
  async_camera.rs  (5 functions)
  core.rs  (116 functions)
  ffmpeg.rs  (14 functions)
  macos.rs  (27 functions)
  macos_fragmented_m4s.rs  (23 functions)
  mod.rs
  win.rs  (33 functions)
  win_fragmented_m4s.rs  (20 functions)
  win_segmented.rs  (17 functions)
  win_segmented_camera.rs  (18 functions)
crates/recording/src/sources/
  audio_mixer.rs  (20 functions)
  camera.rs  (6 functions)
  microphone.rs  (15 functions)
  mod.rs
  native_camera.rs  (3 functions)
crates/recording/src/sources/screen_capture/
  macos.rs  (26 functions)
  mod.rs  (17 functions)
  windows.rs  (24 functions)
crates/recording/src/test_sources/
  audio.rs  (5 functions)
  config.rs  (33 functions)
  mod.rs
  sync.rs  (16 functions)
  validation.rs  (13 functions)
  video.rs  (17 functions)
crates/recording/tests/
  hardware_compat.rs  (2 functions)
  hardware_instant_recording.rs  (2 functions)
  instant_mode_scenarios.rs  (76 functions)
  recovery.rs  (19 functions)
  segmented_pipeline.rs  (8 functions)
  synthetic_recording.rs
crates/rendering-skia/src/
  context.rs  (6 functions)
  lib.rs
crates/rendering-skia/src/bin/
  test_background.rs  (1 functions)
  test_skia.rs  (2 functions)
crates/rendering-skia/src/layers/
  background.rs  (12 functions)
  mod.rs  (11 functions)
crates/rendering/src/
  adapter_luid.rs  (1 functions)
  composite_frame.rs  (10 functions)
  coord.rs  (11 functions)
  cpu_yuv.rs  (27 functions)
  cursor_interpolation.rs  (26 functions)
  d3d_texture.rs  (16 functions)
  frame_pipeline.rs  (43 functions)
  iosurface_texture.rs  (7 functions)
  lib.rs  (93 functions)
  main.rs  (5 functions)
  mask.rs  (6 functions)
  project_recordings.rs  (9 functions)
  scene.rs  (11 functions)
  spring_mass_damper.rs  (7 functions)
  text.rs  (2 functions)
  yuv_converter.rs  (34 functions)
  zoom.rs  (28 functions)
  zoom_focus_interpolation.rs  (20 functions)
crates/rendering/src/decoder/
  avassetreader.rs  (21 functions)
  ffmpeg.rs  (6 functions)
  frame_converter.rs  (6 functions)
  media_foundation.rs  (13 functions)
  mod.rs  (46 functions)
  multi_position.rs  (22 functions)
crates/rendering/src/layers/
  background.rs  (11 functions)
  blur.rs  (5 functions)
  camera.rs  (9 functions)
  captions.rs  (18 functions)
  cursor.rs  (21 functions)
  display.rs  (9 functions)
  keyboard.rs  (19 functions)
  mask.rs  (6 functions)
  mod.rs
  text.rs  (3 functions)
crates/scap-cpal/src/
  lib.rs  (5 functions)
crates/scap-direct3d/examples/
  cli.rs  (1 functions)
crates/scap-direct3d/src/
  lib.rs  (33 functions)
  windows_version.rs  (6 functions)
crates/scap-ffmpeg/examples/
  cli.rs  (1 functions)
crates/scap-ffmpeg/src/
  cpal.rs  (1 functions)
  direct3d.rs  (3 functions)
  lib.rs
  screencapturekit.rs  (4 functions)
crates/scap-screencapturekit/examples/
  cli.rs  (1 functions)
crates/scap-screencapturekit/src/
  capture.rs  (16 functions)
  config.rs  (16 functions)
  lib.rs  (1 functions)
  permission.rs  (2 functions)
crates/scap-targets/src/
  bounds.rs  (21 functions)
  lib.rs  (28 functions)
  main.rs  (1 functions)
crates/scap-targets/src/platform/
  macos.rs  (36 functions)
  mod.rs
  win.rs  (49 functions)
crates/timestamp/src/
  lib.rs  (11 functions)
  macos.rs  (8 functions)
  win.rs  (11 functions)
crates/utils/src/
  lib.rs  (21 functions)
crates/video-decode/src/
  avassetreader.rs  (28 functions)
  ffmpeg.rs  (13 functions)
  lib.rs
  media_foundation.rs  (32 functions)
crates/video-decode/src/bin/
  print_frames.rs  (2 functions)
crates/workspace-hack/
  build.rs  (1 functions)
crates/workspace-hack/src/
  lib.rs
infra/
  sst-env.d.ts
  sst.config.ts  (9 functions)
packages/config/
  config.ts
packages/config/vite/
  index.ts
  relativeAliasResolver.ts  (1 functions)
packages/database/
  crypto.ts  (6 functions)
  drizzle.config.ts
  dub.ts  (1 functions)
  helpers.ts
  index.ts  (3 functions)
  migrate.ts  (3 functions)
  schema.ts  (2 functions)
  tsdown.config.ts
packages/database/auth/
  auth-options.ts  (11 functions)
  domain-utils.ts  (4 functions)
  drizzle-adapter.ts  (15 functions)
  session.ts  (1 functions)
packages/database/emails/
  config.ts  (2 functions)
  feedback.tsx  (1 functions)
  first-shareable-link.tsx  (1 functions)
  first-view.tsx  (1 functions)
  login-link.tsx  (1 functions)
  new-comment.tsx  (1 functions)
  organization-invite.tsx  (1 functions)
  otp-email.tsx  (1 functions)
packages/database/emails/components/
  Footer.tsx  (1 functions)
packages/database/migrations/
  orgid_backfill.ts  (5 functions)
packages/database/types/
  index.ts
  metadata.ts
  next-auth.d.ts
packages/env/
  build.ts  (2 functions)
  index.ts
  server.ts  (3 functions)
  tsdown.config.ts
packages/sdk-embed/
  tsup.config.ts
packages/sdk-embed/src/
  index.ts
  types.ts
packages/sdk-embed/src/react/
  CapEmbed.tsx  (1 functions)
  index.ts
packages/sdk-embed/src/vanilla/
  cap-embed-loader.ts  (1 functions)
  cap-embed.ts  (2 functions)
packages/sdk-recorder/
  tsup.config.ts
packages/sdk-recorder/src/
  index.ts  (16 functions)
  types.ts
packages/sdk-recorder/src/core/
  mime-types.ts  (1 functions)
  stream-manager.ts  (3 functions)
packages/sdk-recorder/src/react/
  index.ts
  useCapRecorder.ts  (1 functions)
packages/sdk-recorder/src/upload/
  multipart-client.ts  (4 functions)
packages/ui/
  index.ts
  postcss.config.js
  tailwind.config.js
packages/ui-solid/
  tailwind.config.js  (1 functions)
  vite.js  (2 functions)
packages/ui-solid/src/
  Button.stories.tsx
  Button.tsx  (1 functions)
  ProgressCircle.tsx  (3 functions)
  SwitchTab.tsx  (3 functions)
  auto-imports.d.ts
  index.tsx
  types.d.ts
packages/ui/src/
  index.tsx
packages/ui/src/components/
  Avatar.tsx  (1 functions)
  Button.tsx
  Card.tsx
  Cmdk.tsx  (2 functions)
  Dialog.tsx  (2 functions)
  Dropdown.tsx  (1 functions)
  LoadingSpinner.tsx  (1 functions)
  LogoSpinner.tsx  (1 functions)
  NavigationMenu.tsx
  Pagination.tsx  (5 functions)
  Popover.tsx
  Select.tsx  (11 functions)
  SkeletonPage.tsx  (1 functions)
  SkeletonRows.tsx  (1 functions)
  Switch.tsx
  Table.tsx
packages/ui/src/components/icons/
  Logo.tsx  (1 functions)
  LogoBadge.tsx  (1 functions)
packages/ui/src/components/input/
  Form.tsx  (2 functions)
  Input.tsx
  Label.tsx
packages/ui/src/utils/
  helpers.ts
packages/ui/style/
  index.ts
  postcss.config.js
  tailwind.config.js  (1 functions)
packages/utils/
  tsdown.config.ts
packages/utils/src/
  helpers.ts  (12 functions)
  index.ts
packages/utils/src/constants/
  plans.ts  (1 functions)
packages/utils/src/lib/
  dub.ts  (1 functions)
packages/utils/src/lib/stripe/
  stripe.ts  (3 functions)
packages/utils/src/types/
  database.ts
packages/web-api-contract-effect/src/
  index.ts
packages/web-api-contract/src/
  desktop.ts
  index.ts
  util.ts
packages/web-backend/
  tsdown.config.ts
packages/web-backend/src/
  Auth.ts  (4 functions)
  Aws.ts
  Database.ts
  Rpcs.ts
  Workflows.ts
  index.ts
packages/web-backend/src/Folders/
  FoldersPolicy.ts  (1 functions)
  FoldersRepo.ts  (4 functions)
  FoldersRpcs.ts
  index.ts  (1 functions)
packages/web-backend/src/Http/
  Errors.ts  (1 functions)
  Live.ts
packages/web-backend/src/ImageUploads/
  index.ts
packages/web-backend/src/Loom/
  Http.ts
  ImportVideo.ts
  index.ts
packages/web-backend/src/Organisations/
  OrganisationsPolicy.ts  (2 functions)
  OrganisationsRepo.ts
  OrganisationsRpcs.ts
  index.ts
packages/web-backend/src/S3Buckets/
  S3BucketAccess.ts  (3 functions)
  S3BucketClientProvider.ts
  S3BucketsRepo.ts
  index.ts  (9 functions)
packages/web-backend/src/Spaces/
  SpacesPolicy.ts  (3 functions)
  SpacesRepo.ts
  index.ts
packages/web-backend/src/Tinybird/
  index.ts  (7 functions)
packages/web-backend/src/Users/
  UsersOnboarding.ts
  UsersRpcs.ts
  index.ts
packages/web-backend/src/Videos/
  VideosPolicy.ts  (3 functions)
  VideosRepo.ts  (3 functions)
  VideosRpcs.ts
  index.ts  (8 functions)
packages/web-domain/
  tsdown.config.ts
packages/web-domain/scripts/
  generate-openapi.ts
packages/web-domain/src/
  Authentication.ts
  Comment.ts
  Database.ts
  Errors.ts
  Folder.ts
  ImageUpload.ts  (1 functions)
  Loom.ts
  Organisation.ts
  Policy.ts  (6 functions)
  Rpcs.ts
  S3Bucket.ts
  Space.ts
  User.ts
  Video.ts  (10 functions)
  index.ts
  utils.ts  (1 functions)
packages/web-domain/src/Http/
  Api.ts
  Errors.ts
  index.ts
scripts/
  check-tauri-plugin-versions.js  (7 functions)
  env-cli.js  (1 functions)
  setup.js  (6 functions)
  symbolicate-macos-crash.js  (1 functions)
scripts/analytics/
  check-analytics.js  (6 functions)
  delete-all-data.js  (3 functions)
  migrate-dub-to-tinybird.js  (26 functions)
  populate-test-data.js  (11 functions)
  setup-analytics.js  (6 functions)
  shared.js  (8 functions)
vendor/tao/examples/
  control_flow.rs  (1 functions)
  cursor.rs  (1 functions)
  cursor_grab.rs  (1 functions)
  custom_events.rs  (1 functions)
  decorations.rs  (1 functions)
  drag_window.rs  (2 functions)
  fullscreen.rs  (3 functions)
  handling_close.rs  (1 functions)
  min_max_size.rs  (1 functions)
  minimize.rs  (1 functions)
  monitor_list.rs  (1 functions)
  mouse_wheel.rs  (1 functions)
  multithreaded.rs  (1 functions)
  multiwindow.rs  (1 functions)
  overlay.rs  (1 functions)
  parentwindow.rs  (1 functions)
  progress_bar.rs  (1 functions)
  reopen_event.rs  (1 functions)
  request_redraw.rs  (1 functions)
  request_redraw_threaded.rs  (1 functions)
  resizable.rs  (1 functions)
  set_ime_position.rs  (1 functions)
  theme.rs  (1 functions)
  timer.rs  (1 functions)
  transparent.rs  (1 functions)
  video_modes.rs  (1 functions)
  window.rs  (1 functions)
  window_debug.rs  (2 functions)
  window_icon.rs  (2 functions)
  window_run_return.rs  (1 functions)
vendor/tao/src/
  error.rs  (5 functions)
  event.rs  (7 functions)
  event_loop.rs  (19 functions)
  icon.rs  (6 functions)
  keyboard.rs  (12 functions)
  lib.rs  (1 functions)
  monitor.rs  (12 functions)
  window.rs  (103 functions)
vendor/tao/src/platform/
  android.rs  (2 functions)
  ios.rs  (20 functions)
  linux.rs
  macos.rs  (40 functions)
  mod.rs
  run_return.rs  (1 functions)
  unix.rs  (22 functions)
  windows.rs  (31 functions)
vendor/tao/src/platform_impl/
  mod.rs
vendor/tao/src/platform_impl/android/
  mod.rs  (93 functions)
  ndk_glue.rs  (16 functions)
vendor/tao/src/platform_impl/ios/
  app_state.rs  (38 functions)
  badge.rs  (1 functions)
  event_loop.rs  (24 functions)
  ffi.rs  (13 functions)
  keycode.rs  (2 functions)
  mod.rs  (2 functions)
  monitor.rs  (21 functions)
  view.rs  (23 functions)
  window.rs  (81 functions)
vendor/tao/src/platform_impl/linux/
  device.rs  (1 functions)
  event_loop.rs  (24 functions)
  icon.rs  (2 functions)
  keyboard.rs  (6 functions)
  keycode.rs  (2 functions)
  mod.rs  (3 functions)
  monitor.rs  (11 functions)
  taskbar.rs  (6 functions)
  util.rs  (4 functions)
  window.rs  (72 functions)
vendor/tao/src/platform_impl/linux/wayland/
  header.rs  (2 functions)
  mod.rs
vendor/tao/src/platform_impl/linux/x11/
  ffi.rs
  mod.rs
  xdisplay.rs  (10 functions)
vendor/tao/src/platform_impl/macos/
  app.rs  (2 functions)
  app_delegate.rs  (10 functions)
  app_state.rs  (36 functions)
  badge.rs  (1 functions)
  dock.rs  (3 functions)
  event.rs  (9 functions)
  event_loop.rs  (25 functions)
  ffi.rs
  icon.rs  (1 functions)
  keycode.rs  (2 functions)
  mod.rs  (4 functions)
  monitor.rs  (24 functions)
  observer.rs  (12 functions)
  progress_bar.rs  (6 functions)
  view.rs  (51 functions)
  window.rs  (103 functions)
  window_delegate.rs  (35 functions)
vendor/tao/src/platform_impl/macos/util/
  async.rs  (18 functions)
  cursor.rs  (4 functions)
  mod.rs  (14 functions)
vendor/tao/src/platform_impl/windows/
  dark_mode.rs  (8 functions)
  dpi.rs  (5 functions)
  drop_handler.rs  (6 functions)
  event.rs  (11 functions)
  event_loop.rs  (44 functions)
  icon.rs  (11 functions)
  keyboard.rs  (13 functions)
  keyboard_layout.rs  (13 functions)
  keycode.rs  (2 functions)
  minimal_ime.rs  (3 functions)
  mod.rs  (8 functions)
  monitor.rs  (25 functions)
  raw_input.rs  (9 functions)
  util.rs  (40 functions)
  window.rs  (82 functions)
  window_state.rs  (16 functions)
vendor/tao/src/platform_impl/windows/event_loop/
  runner.rs  (26 functions)
vendor/wgpu-hal/
  build.rs  (1 functions)
vendor/wgpu-hal/examples/
  raw-gles.rs  (3 functions)
vendor/wgpu-hal/examples/halmark/
  main.rs  (7 functions)
vendor/wgpu-hal/examples/ray-traced-triangle/
  main.rs  (20 functions)
vendor/wgpu-hal/src/
  lib.rs  (21 functions)
vendor/wgpu-hal/src/auxil/
  mod.rs  (6 functions)
  renderdoc.rs  (4 functions)
vendor/wgpu-hal/src/auxil/dxgi/
  conv.rs  (10 functions)
  exception.rs  (3 functions)
  factory.rs  (5 functions)
  mod.rs
  name.rs  (1 functions)
  result.rs  (1 functions)
  time.rs  (4 functions)
vendor/wgpu-hal/src/dx12/
  adapter.rs  (8 functions)
  command.rs  (59 functions)
  conv.rs  (23 functions)
  descriptor.rs  (19 functions)
  device.rs  (53 functions)
  instance.rs  (3 functions)
  mod.rs  (45 functions)
  sampler.rs  (7 functions)
  shader_compilation.rs  (11 functions)
  suballocation.rs  (15 functions)
  types.rs  (2 functions)
  view.rs  (6 functions)
vendor/wgpu-hal/src/dynamic/
  adapter.rs  (5 functions)
  command.rs  (49 functions)
  device.rs  (48 functions)
  instance.rs  (4 functions)
  mod.rs  (4 functions)
  queue.rs  (3 functions)
  surface.rs  (4 functions)
vendor/wgpu-hal/src/gles/
  adapter.rs  (11 functions)
  command.rs  (60 functions)
  conv.rs  (16 functions)
  device.rs  (51 functions)
  egl.rs  (35 functions)
  emscripten.rs  (1 functions)
  fence.rs  (7 functions)
  mod.rs  (11 functions)
  queue.rs  (11 functions)
  web.rs  (17 functions)
  wgl.rs  (27 functions)
vendor/wgpu-hal/src/metal/
  adapter.rs  (12 functions)
  command.rs  (56 functions)
  conv.rs  (24 functions)
  device.rs  (53 functions)
  layer_observer.rs  (5 functions)
  mod.rs  (30 functions)
  surface.rs  (9 functions)
  time.rs  (2 functions)
vendor/wgpu-hal/src/noop/
  buffer.rs  (3 functions)
  command.rs  (52 functions)
  mod.rs  (59 functions)
vendor/wgpu-hal/src/vulkan/
  adapter.rs  (28 functions)
  command.rs  (52 functions)
  conv.rs  (46 functions)
  device.rs  (83 functions)
  drm.rs  (1 functions)
  instance.rs  (27 functions)
  mod.rs  (41 functions)
  sampler.rs  (5 functions)
```

## Functional Clusters

Files grouped by subsystem. When changing one file in a cluster, check the others for impact.

**components** (101 files)
- `apps/desktop/src/components/CapErrorBoundary.tsx`
- `apps/desktop/src/components/Cropper.tsx`
- `apps/desktop/src/components/Mode.tsx`
- `apps/desktop/src/components/ModeSelect.tsx`
- `apps/desktop/src/components/RecoveryToast.tsx`
- `apps/desktop/src/components/SignInButton.tsx`
- `apps/desktop/src/components/Toggle.tsx`
- `apps/desktop/src/components/Tooltip.tsx`
- ... and 93 more

**unit** (44 files)
- `apps/web/__tests__/unit/async-video-code-reviews-page.test.ts`
- `apps/web/__tests__/unit/audio-extract.test.ts`
- `apps/web/__tests__/unit/avi-to-mp4-page.test.ts`
- `apps/web/__tests__/unit/best-screen-recorder-page.test.ts`
- `apps/web/__tests__/unit/breadcrumb-schema.test.ts`
- `apps/web/__tests__/unit/canonical-urls.test.ts`
- `apps/web/__tests__/unit/developer-actions.test.ts`
- `apps/web/__tests__/unit/developer-api-auth.test.ts`
- ... and 36 more

**utils** (43 files)
- `apps/desktop/src/utils/analytics.ts`
- `apps/desktop/src/utils/auth.ts`
- `apps/desktop/src/utils/composeEventHandlers.ts`
- `apps/desktop/src/utils/createEventListener.ts`
- `apps/desktop/src/utils/createPresets.ts`
- `apps/desktop/src/utils/devices.ts`
- `apps/desktop/src/utils/events.ts`
- `apps/desktop/src/utils/export.ts`
- ... and 35 more

**_components** (43 files)
- `apps/web/app/(docs)/docs/_components/DocsBreadcrumbs.tsx`
- `apps/web/app/(docs)/docs/_components/DocsHeader.tsx`
- `apps/web/app/(docs)/docs/_components/DocsMobileMenu.tsx`
- `apps/web/app/(docs)/docs/_components/DocsPrevNext.tsx`
- `apps/web/app/(docs)/docs/_components/DocsSearch.tsx`
- `apps/web/app/(docs)/docs/_components/DocsSidebar.tsx`
- `apps/web/app/(docs)/docs/_components/DocsTableOfContents.tsx`
- `apps/web/app/(org)/dashboard/_components/Avatar.tsx`
- ... and 35 more

**lib.rs** (40 files)
- `apps/desktop/src-tauri/src/lib.rs`
- `crates/audio/src/lib.rs`
- `crates/camera-avfoundation/src/lib.rs`
- `crates/camera-directshow/src/lib.rs`
- `crates/camera-ffmpeg/src/lib.rs`
- `crates/camera-mediafoundation/src/lib.rs`
- `crates/camera-windows/src/lib.rs`
- `crates/camera/src/lib.rs`
- ... and 32 more

**src** (40 files)
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/entry-client.tsx`
- `apps/desktop/src/entry-server.tsx`
- `apps/desktop/src/global.d.ts`
- `apps/desktop/src/store.ts`
- `apps/discord-bot/src/index.ts`
- `apps/media-server/src/app.ts`
- `apps/media-server/src/index.ts`
- ... and 32 more

**mod.rs** (39 files)
- `apps/desktop/src-tauri/src/platform/macos/mod.rs`
- `apps/desktop/src-tauri/src/platform/mod.rs`
- `apps/desktop/src-tauri/src/thumbnails/mod.rs`
- `crates/cap-test/src/config/mod.rs`
- `crates/cap-test/src/discovery/mod.rs`
- `crates/cap-test/src/matrix/mod.rs`
- `crates/cap-test/src/results/mod.rs`
- `crates/cap-test/src/suites/mod.rs`
- ... and 31 more

**lib** (35 files)
- `apps/media-server/src/__tests__/lib/ffmpeg-video.integration.test.ts`
- `apps/media-server/src/__tests__/lib/ffmpeg.integration.test.ts`
- `apps/media-server/src/__tests__/lib/ffprobe.integration.test.ts`
- `apps/media-server/src/__tests__/lib/memory-leak.test.ts`
- `apps/media-server/src/lib/ffmpeg-video.ts`
- `apps/media-server/src/lib/ffmpeg.ts`
- `apps/media-server/src/lib/ffprobe.ts`
- `apps/media-server/src/lib/job-manager.ts`
- ... and 27 more

**editor** (31 files)
- `apps/desktop/src/routes/editor/AspectRatioSelect.tsx`
- `apps/desktop/src/routes/editor/CaptionsTab.tsx`
- `apps/desktop/src/routes/editor/ConfigSidebar.tsx`
- `apps/desktop/src/routes/editor/Editor.tsx`
- `apps/desktop/src/routes/editor/EditorErrorScreen.tsx`
- `apps/desktop/src/routes/editor/ExportPage.tsx`
- `apps/desktop/src/routes/editor/GradientEditor.tsx`
- `apps/desktop/src/routes/editor/Header.tsx`
- ... and 23 more

**web-recorder-dialog** (29 files)
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/CameraPreviewWindow.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/CameraSelector.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/HowItWorksButton.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/HowItWorksPanel.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/InProgressRecordingBar.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/MicrophoneSelector.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/RecordingButton.tsx`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/RecordingModeSelector.tsx`
- ... and 21 more

## Key Workflows (Execution Flows)

Multi-step call chains representing user-facing workflows. When changing any step, check the full chain.

**apps > web > app > api > dashboard > analytics**
  `GET` -> `getCurrentUser` -> `getOrgAnalyticsData` -> `getSpaceVideoIds` -> `resolveRangeBounds` -> `buildBuckets` -> `loadVideoNames` -> `all` -> `where` -> `db` -> `getLifetimeRangeStart` -> `getTime` -> `floor` -> `formatBucketTimestamp` -> `inArray` -> `and` -> `limit` -> `slice` -> `toISOString`
  Entry: `apps/web/app/api/dashboard/analytics/route.ts`

**apps > web > app > messenger**
  `MessengerPage` -> `notFound` -> `listViewerMessengerConversations` -> `relativeTime` -> `getViewerContext` -> `linkAnonymousConversationsToUser` -> `limit` -> `orderBy` -> `where` -> `now` -> `getTime` -> `floor` -> `format` -> `all` -> `getCurrentUser` -> `cookies` -> `db` -> `and` -> `isNull`
  Entry: `apps/web/app/messenger/page.tsx`

**apps > web > app > (org) > dashboard > import > file > ImportFilePage.tsx**
  `ImportFilePage` -> `useDashboardContext` -> `useUploadingContext` -> `useStore` -> `setUpgradeModalOpen` -> `uploadVideoForServerProcessing` -> `useContext` -> `setUploadStatus` -> `parseMedia` -> `round` -> `createVideoForServerProcessing` -> `createProgressTracker` -> `getCurrentUser` -> `userIsPro` -> `where` -> `db` -> `make` -> `now`
  Entry: `apps/web/app/(org)/dashboard/import/file/ImportFilePage.tsx`

**apps > web > app > (site) > blog > [slug]**
  `PostPage` -> `getBlogPosts` -> `notFound` -> `isInteractiveBlogPost` -> `getInteractiveBlogContent` -> `calculateReadingTime` -> `getMDXData` -> `cwd` -> `getInteractiveBlogPosts` -> `ceil` -> `max` -> `getMDXFiles` -> `readMDXFile` -> `getAllInteractiveBlogPosts` -> `scanDir` -> `readFileSync` -> `parseFrontmatter`
  Entry: `apps/web/app/(site)/blog/[slug]/page.tsx`

**apps > web > app > api > analytics**
  `GET` -> `parseRangeParam` -> `getVideoAnalytics` -> `endsWith` -> `slice` -> `isFinite` -> `limit` -> `where` -> `db` -> `make` -> `runPromise` -> `runPromiseExit` -> `pipe` -> `provide` -> `isFailure` -> `isDieType`
  Entry: `apps/web/app/api/analytics/route.ts`

**apps > web > app > messenger**
  `startConversation` -> `createMessengerConversation` -> `assertMessengerEnabled` -> `getViewerContext` -> `getOrCreateAnonymousId` -> `linkAnonymousConversationsToUser` -> `limit` -> `all` -> `getCurrentUser` -> `cookies` -> `nanoIdLong` -> `where` -> `db` -> `and` -> `isNull`
  Entry: `apps/web/app/messenger/page.tsx`

**apps > web > app > s > [videoId]**
  `AuthorizedContent` -> `getCurrentUser` -> `createNotification` -> `pipe` -> `optionFromTOrFirst` -> `getDashboardData` -> `limit` -> `where` -> `db` -> `make` -> `and` -> `fromNullable` -> `isArray` -> `isNull` -> `or`
  Entry: `apps/web/app/s/[videoId]/page.tsx`

**apps > web > components > pages > UpdatesPage.tsx**
  `UpdatesPage` -> `getBlogPosts` -> `sort` -> `getTime` -> `isInteractiveBlogPost` -> `getInteractiveBlogContent` -> `getMDXData` -> `cwd` -> `getInteractiveBlogPosts` -> `getMDXFiles` -> `readMDXFile` -> `getAllInteractiveBlogPosts` -> `scanDir` -> `readFileSync` -> `parseFrontmatter`
  Entry: `apps/web/components/pages/UpdatesPage.tsx`

**apps > web > app > (org) > dashboard > import > loom > ImportLoomPage.tsx**
  `ImportLoomPage` -> `useDashboardContext` -> `setLoomUrl` -> `handleImport` -> `useContext` -> `setUpgradeModalOpen` -> `setIsImporting` -> `importFromLoom` -> `getCurrentUser` -> `userIsPro` -> `extractLoomVideoId` -> `where` -> `leftJoin`
  Entry: `apps/web/app/(org)/dashboard/import/loom/ImportLoomPage.tsx`

**apps > web > app > api > changelog**
  `GET` -> `getChangelogPosts` -> `sort` -> `fromEntries` -> `getCorsHeaders` -> `getMDXData` -> `getMDXFiles` -> `readMDXFile` -> `basename` -> `extname` -> `readdirSync` -> `readFileSync` -> `parseFrontmatter`
  Entry: `apps/web/app/api/changelog/route.ts`

## Critical Paths (Elevated Risk)

Changes to these subsystems affect core functionality. Extra caution required.

**Auth** (5 files)
- `apps/web/__tests__/unit/developer-api-auth.test.ts` (466 relationships)
- `packages/database/auth/drizzle-adapter.ts` (186 relationships)
- `apps/web/app/(org)/login/form.tsx` (94 relationships)
- `apps/desktop/src/utils/auth.ts` (78 relationships)
- `packages/database/auth/auth-options.ts` (74 relationships)

**Workflow** (5 files)
- `vendor/tao/src/platform_impl/ios/app_state.rs` (290 relationships)
- `vendor/tao/src/platform_impl/macos/app_state.rs` (230 relationships)
- `apps/web/workflows/transcribe.ts` (213 relationships)
- `vendor/tao/src/platform_impl/windows/window_state.rs` (135 relationships)
- `apps/web/workflows/generate-ai.ts` (134 relationships)

**Email** (5 files)
- `apps/web/__tests__/unit/email-restriction.test.ts` (168 relationships)
- `apps/web/lib/Notification.ts` (144 relationships)
- `apps/web/app/api/email/new-comment/route.ts` (93 relationships)
- `apps/web/actions/organization/send-invites.ts` (66 relationships)
- `apps/web/app/api/notifications/route.ts` (62 relationships)

**Editor** (5 files)
- `apps/desktop/src/routes/editor/ConfigSidebar.tsx` (604 relationships)
- `crates/editor/src/playback.rs` (463 relationships)
- `apps/desktop/src-tauri/src/screenshot_editor.rs` (462 relationships)
- `apps/desktop/src/routes/editor/ExportPage.tsx` (393 relationships)
- `apps/desktop/src/routes/editor/Editor.tsx` (364 relationships)

**Data** (5 files)
- `apps/web/__tests__/unit/breadcrumb-schema.test.ts` (139 relationships)
- `apps/web/__tests__/unit/faq-schema.test.ts` (136 relationships)
- `packages/database/migrations/orgid_backfill.ts` (128 relationships)
- `apps/web/__tests__/unit/howto-schema.test.ts` (112 relationships)
- `apps/web/app/admin/AdminPanel.tsx` (101 relationships)

## External Dependencies

External packages used by this codebase. When adding new dependencies, document them in the spec. When changing code that uses these packages, verify API compatibility.

| Package | Files Using It |
|---|---|
| `` | `apps/desktop/scripts/desktop-memory-soak.js`, `apps/desktop/scripts/desktop-memory-soak.test.js`, `apps/desktop/src/App.tsx` +686 more |
| `next` | `apps/web/actions/caps/share.ts`, `apps/web/actions/developers/add-domain.ts`, `apps/web/actions/developers/delete-app.ts` +302 more |
| `react` | `apps/web/app/(docs)/docs/_components/DocsHeader.tsx`, `apps/web/app/(docs)/docs/_components/DocsMobileMenu.tsx`, `apps/web/app/(docs)/docs/_components/DocsSearch.tsx` +250 more |
| `@cap/web-domain` | `apps/web/__tests__/integration/transcribe.test.ts`, `apps/web/__tests__/unit/videos-policy.test.ts`, `apps/web/actions/admin/replace-video.ts` +184 more |
| `@cap/database` | `apps/web/__tests__/unit/developer-actions.test.ts`, `apps/web/__tests__/unit/developer-credits-checkout.test.ts`, `apps/web/__tests__/unit/loom-import.test.ts` +173 more |
| `@cap/ui` | `apps/web/app/(docs)/docs/_components/DocsHeader.tsx`, `apps/web/app/(org)/dashboard/_components/ConfirmationDialog.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/CapAIBox.tsx` +146 more |
| `drizzle-orm` | `apps/web/actions/admin/replace-video.ts`, `apps/web/actions/analytics/track-user-signed-up.ts`, `apps/web/actions/billing/track-meta-purchase.ts` +139 more |
| `effect` | `apps/desktop/src/routes/editor/Timeline/ZoomTrack.tsx`, `apps/web-cluster/scripts/post-deploy.ts`, `apps/web-cluster/src/cluster/container-metadata.ts` +121 more |
| `solid-js` | `apps/desktop/src/App.tsx`, `apps/desktop/src/components/CapErrorBoundary.tsx`, `apps/desktop/src/components/Cropper.tsx` +118 more |
| `lucide-react` | `apps/web/app/(docs)/docs/_components/DocsBreadcrumbs.tsx`, `apps/web/app/(docs)/docs/_components/DocsHeader.tsx`, `apps/web/app/(docs)/docs/_components/DocsMobileMenu.tsx` +85 more |
| `@cap/env` | `apps/web/actions/admin/replace-video.ts`, `apps/web/actions/loom.ts`, `apps/web/actions/messenger.ts` +83 more |
| `@fortawesome/react-fontawesome` | `apps/web/app/(org)/dashboard/_components/Navbar/CapAIDialog.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/SpaceDialog.tsx` +79 more |
| `@fortawesome/free-solid-svg-icons` | `apps/web/app/(org)/dashboard/_components/Navbar/CapAIDialog.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/SpaceDialog.tsx` +78 more |
| `sonner` | `apps/web/app/(org)/dashboard/_components/Navbar/SpaceDialog.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/SpacesList.tsx`, `apps/web/app/(org)/dashboard/_components/Notifications/NotificationHeader.tsx` +74 more |
| `clsx` | `apps/web/app/(org)/dashboard/_components/Avatar.tsx`, `apps/web/app/(org)/dashboard/_components/MobileTab.tsx`, `apps/web/app/(org)/dashboard/_components/Navbar/CapAIBox.tsx` +73 more |
| `cva` | `apps/desktop/src/components/ModeSelect.tsx`, `apps/desktop/src/components/Toggle.tsx`, `apps/desktop/src/components/Tooltip.tsx` +56 more |
| `@tauri-apps/api` | `apps/desktop/src/App.tsx`, `apps/desktop/src/components/CapErrorBoundary.tsx`, `apps/desktop/src/components/Cropper.tsx` +53 more |
| `@cap/utils` | `apps/web/__tests__/unit/email-restriction.test.ts`, `apps/web/actions/billing/track-meta-purchase.ts`, `apps/web/actions/loom.ts` +51 more |
| `vitest` | `apps/desktop/scripts/desktop-memory-soak.test.js`, `apps/desktop/src/utils/general-settings.test.ts`, `apps/desktop/src/utils/hex-color.test.ts` +50 more |
| `super::*` | `apps/desktop/src-tauri/src/export.rs`, `apps/desktop/src-tauri/src/permissions.rs`, `apps/desktop/src-tauri/src/recording.rs` +47 more |

## Dead Code (Unreferenced)

Functions and components with no callers or importers. These may be genuinely unused or may be called by framework conventions not captured by static analysis. Review before deleting. When writing specs, check if your changes create new dead code or if existing dead code should be cleaned up.

| Function | File | Lines |
|---|---|---|
| `Cli` | `apps/cli/src/main.rs` | 4 |
| `Commands` | `apps/cli/src/main.rs` | 6 |
| `Export` | `apps/cli/src/main.rs` | 38 |
| `RecordArgs` | `apps/cli/src/main.rs` | 7 |
| `RecordCommands` | `apps/cli/src/main.rs` | 9 |
| `RecordStart` | `apps/cli/src/record.rs` | 56 |
| `RecordTargets` | `apps/cli/src/record.rs` | 8 |
| `Data` | `apps/desktop/src-tauri/src/api.rs` | 3 |
| `MultipartCompleteRequest` | `apps/desktop/src-tauri/src/api.rs` | 7 |
| `Organization` | `apps/desktop/src-tauri/src/api.rs` | 5 |
| `PresignedS3PutRequest` | `apps/desktop/src-tauri/src/api.rs` | 7 |
| `PresignedS3PutRequestMethod` | `apps/desktop/src-tauri/src/api.rs` | 5 |
| `Response` | `apps/desktop/src-tauri/src/api.rs` | 3 |
| `S3VideoMeta` | `apps/desktop/src-tauri/src/api.rs` | 8 |
| `UploadedPart` | `apps/desktop/src-tauri/src/api.rs` | 7 |
| `desktop_video_progress` | `apps/desktop/src-tauri/src/api.rs` | 29 |
| `fetch_organizations` | `apps/desktop/src-tauri/src/api.rs` | 19 |
| `signal_recording_complete` | `apps/desktop/src-tauri/src/api.rs` | 27 |
| `upload_multipart_complete` | `apps/desktop/src-tauri/src/api.rs` | 52 |
| `upload_multipart_initiate` | `apps/desktop/src-tauri/src/api.rs` | 36 |
| `upload_multipart_presign_part` | `apps/desktop/src-tauri/src/api.rs` | 46 |
| `upload_signed` | `apps/desktop/src-tauri/src/api.rs` | 36 |
| `AppSounds` | `apps/desktop/src-tauri/src/audio.rs` | 15 |
| `get_waveform` | `apps/desktop/src-tauri/src/audio.rs` | 30 |
| `Eq` | `apps/desktop/src-tauri/src/audio_meter.rs` | 1 |
| `Ord` | `apps/desktop/src-tauri/src/audio_meter.rs` | 5 |
| `PartialOrd` | `apps/desktop/src-tauri/src/audio_meter.rs` | 5 |
| `VolumeMeter` | `apps/desktop/src-tauri/src/audio_meter.rs` | 37 |
| `spawn_event_emitter` | `apps/desktop/src-tauri/src/audio_meter.rs` | 19 |
| `AuthSecret` | `apps/desktop/src-tauri/src/auth.rs` | 4 |
| ... | 5919 more | |

## Build Commands

- `npm run dev`: `pnpm run docker:up && trap 'pnpm run docker:stop' EXIT && dotenv -e .env -- turbo run dev --env-mode=loose --ui tui`
- `npm run build`: `dotenv -e .env -- turbo run build`
- `npm run lint`: `pnpm exec biome lint`
- `npm run test`: `turbo run test`
- `npm run typecheck`: `pnpm tsc -b`

## Project Instructions (from CLAUDE.md)

See CLAUDE.md for project-specific design patterns, constraints, and conventions.
