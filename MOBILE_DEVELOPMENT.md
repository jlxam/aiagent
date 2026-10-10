# Mobile Development Mode

Agent26 can develop Android and iOS applications from the same local AI agent.

## Recommended stack

For a new cross-platform application, use:

- React Native
- Expo
- TypeScript
- React Navigation or Expo Router when appropriate
- Ollama `qwen3:8b` for coding/reasoning
- Ollama `qwen3-vl:8b` for screenshots/video analysis

If the workspace already contains a native Android, native iOS, Flutter, or React Native project, preserve that stack instead of replacing it.

## Agent workflow

```text
User request
   -> Discover mobile project
   -> Plan
   -> Implement
   -> Typecheck / Test
   -> Android build/run when available
   -> iOS source/build verification when available
   -> Visual verification
   -> Preview / report
```

## Windows requirements for Android

Install/configure as required by the selected project:

- Node.js + npm
- JDK compatible with the Android/Gradle version
- Android Studio
- Android SDK + platform/build tools
- Android Emulator (optional but recommended)
- ADB on PATH
- Expo CLI/project tooling when using Expo

Useful checks:

```powershell
node --version
npm --version
adb version
java -version
```

For an Expo project:

```powershell
npx expo start
```

For native Android projects, use the project's Gradle wrapper and verify the actual build result.

## iOS requirements

The shared React Native/Expo source can be authored on Windows, but native iOS compilation, Simulator verification, and signing require macOS/Xcode unless an external/remote build service is explicitly configured.

The agent must never report an iOS native build as successful without an actual Xcode/remote build result.

## Using the Agent UI

Select:

```text
Mobile
```

in the mode selector and choose:

- Android + iOS
- Android
- iOS

The agent automatically adds mobile development constraints to the task prompt.

## Visual debugging

Attach a screenshot or recording and ask the agent to diagnose it. The local pipeline is:

```text
Screenshot / Video
       -> qwen3-vl:8b
       -> observed evidence
       -> qwen3:8b
       -> source fix
       -> build/typecheck/test
       -> visual verification
```

For video, FFprobe/FFmpeg extracts timestamped frames locally. The agent should distinguish observed facts from hypotheses.
