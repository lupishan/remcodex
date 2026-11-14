# RemCodex mobile app

This Android module is a native shell around the existing RemCodex web client.
It uses the Gitea `chiliahedron/kotlin-template` as its Gradle/Kotlin scaffold
and keeps the server as the source of session, API, and WebSocket behavior.

The debug build defaults to `http://10.0.2.2:18840/` for an Android emulator.
Pass a different server URL with the `com.chiliahedron.remcodex.SERVER_URL`
intent extra, or launch the activity with a URL as its intent data.

From this directory:

```text
./gradlew assembleDebug
```

Release automation is tag-driven. Update `version.properties` together with a
tag named `v<versionName>`; `versionCode` must increase for every published
APK. The release variant is intentionally unsigned. Gitea Actions builds it,
rejects signed output, and attaches the APK, SHA-256 checksum, and JSON
manifest to the Gitea Release. Final APK/repository signing is outside this
repository and must remain on the protected F-Droid publishing host.

The workflow expects a pinned runner label such as
`android-34:docker://<approved-android-image>` and the pre-created
`REMCODEX_RELEASE_TOKEN` Actions secret with permission to create releases and
upload release assets for this repository. It does not create or access
signing keys.

Release builds accept HTTPS servers only and keep navigation on the configured origin. Debug builds allow HTTP for emulator/LAN development. App data backup is disabled. This optional shell is not included in the npm package; Android device validation and signing remain separate release work.
