# Publish a Mac download

Release assets live in GitHub Releases. The README and website link to the DMG;
the ZIP is an alternative. The installer contains the app, an Applications
shortcut and a short installation note.

## Build and sign

Build with a Developer ID Application identity and a secure timestamp. See
`build.sh` for the signing options. The collector must match the app's target
architecture and minimum macOS version; `tools/check-bundle.py` checks both.
Never put personal weather archives, credentials or imported briefings in the
bundle.

## Notarize

Store an Apple notarization credential in Keychain with `xcrun notarytool
store-credentials`, using your own profile name. Do not commit passwords or keys.
Work on a copy of the signed app so the installed app stays untouched:

```sh
mkdir -p build/release-app build/releases
ditto build/Isobar.app build/release-app/Isobar.app
ditto -c -k --keepParent build/release-app/Isobar.app build/notary-upload.zip
xcrun notarytool submit build/notary-upload.zip --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple build/release-app/Isobar.app
```

Continue only after Apple's submission status is **Accepted**. If it fails,
read the submission log and fix the reported issue before packaging.

## Package and verify

Use a new output directory for each attempt:

```sh
python3 tools/package-release.py build/release-app/Isobar.app build/releases/1.8.1 --notarized
```

This checks the standalone collector, signatures, stapled ticket and Gatekeeper
acceptance, then produces a versioned DMG, ZIP and SHA-256 checksums. It never
submits to Apple or publishes to GitHub. Notarization is required by default
(`--notarized` is accepted for older scripts). `--development` packages a local
test candidate without it; its file names end in `-development`, and it is
never a public download.

Verify the DMG with `hdiutil verify`, mount it read-only without opening Finder,
and check its app and Applications shortcut. Extract the ZIP into a fresh folder
and repeat `tools/check-bundle.py`, `stapler validate` and `spctl --assess` there.
Test a browser-downloaded copy on a clean supported Mac before calling the
release ready. Do not use instructions to disable Gatekeeper as the install flow.

## Publish

Create a GitHub Release for the reviewed source revision. Attach the DMG, ZIP and
checksums. Use the app version as the tag, for example `v1.8.1`. Release notes
should start with the supported Macs and these instructions:

1. Open the downloaded disk image.
2. Drag Isobar into Applications.
3. Open Isobar and look for the temperature in the menu bar.

Download the published assets and compare their checksums. Only then replace the
preparation text at the top of `README.md` and `docs/install.md` with the direct
DMG download link. Update `site/release.json` with that same URL and a short
compatibility label; see [hosting](hosting.md). Keep the ZIP on the release page
as a secondary download. Never label an arm64-only build as universal.

Run the focused website check after changing the download UI:

```sh
node tools/test-site.mjs --download-only
```

Confirm GitHub Pages has deployed and the live Download control points to the
published asset. A successful source push alone does not verify deployment.
