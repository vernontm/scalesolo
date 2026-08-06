# Prototypes

## brand-intake.html

A client-facing brand intake questionnaire prototype for ScaleSolo. It walks a
new client through 13 questions about their brand and lets them answer either by
voice or by typing. When finished, it produces a summary the client can copy or
download and send back to us.

The file is fully self-contained: all CSS and JavaScript are inline, with no
external dependencies and no network calls. It lives under `docs/` on purpose so
it is not picked up by the SPA build or served in production by accident.

### How to use it

1. Open `brand-intake.html` directly in Chrome or Edge on desktop.
2. Allow microphone access when the browser asks.
3. Answer each question by voice, or type your answer in the field. You can mix
   both, and you can optionally have each question read aloud.
4. When done, use the Copy or Download button to save the summary and share it.

### Browser limitation

Voice input uses the Web Speech API (`SpeechRecognition`), which only works in
Chrome and Edge on desktop and on Android. It does not work in Firefox or in
Safari on iOS. Typing works everywhere, so the questionnaire is fully usable in
any browser; only the voice shortcut is limited.

### Future integration

Each question maps to a real ScaleSolo `profiles` column, so the collected
answers can later be written straight into a client's profile instead of being
copied by hand. The mapping is defined inline in the question set at the top of
the file's script.
