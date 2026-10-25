# ACTrashBlocker

A Chrome extension that detects explicitly promoted videos on the Bilibili homepage and video pages, verifies the uploader's identity, and lets you add individual uploaders or the entire current list to your **Bilibili account blacklist**.

[Repository](https://github.com/JasonLeon01/ACTrashBlocker) · [Releases](https://github.com/JasonLeon01/ACTrashBlocker/releases) · [GitHub Actions](https://github.com/JasonLeon01/ACTrashBlocker/actions)

The documentation is in English. The extension popup currently uses Chinese text; this guide describes its controls using English equivalents.

## Features

- Detects supported promotion markers, including rocket icons, only when the card has a unique, verifiable Bilibili video destination. Advertising redirect links are supported when their destination is a Bilibili video.
- Automatically hides confirmed display, game, and product advertisements on supported pages, including dynamically loaded ads. This is enabled by default with no settings switch; promoted videos remain visible for uploader review.
- Shows the current page's hidden-ad count separately in the popup. The count updates as ads are hidden, removed, or restored, and resets when the page changes; rescanning the same ad does not increase it.
- Resolves the actual uploader UID through video details. Nicknames, advertising parameters, and the uploader of a neighboring video are never treated as the target UID. Multiple videos from the same uploader appear as one entry.
- Shows the uploader name, UID, source videos, detection evidence, and an individual **Block** control. **Block all** submits every eligible entry in the current list. Entries whose uploader cannot be verified show a reason and cannot be blocked.
- Keeps a separate list for each tab's current page. Scrolling and refreshing recommendations add entries; reloading the page or navigating to another page starts a new list.
- Automatically opens the toolbar popup when the active Bilibili tab discovers new uploaders and updates its count badge. Nearby discoveries are grouped, automatic openings are at least 10 seconds apart, and the same list does not repeatedly reopen the popup.
- Processes a batch sequentially, with at least one second between submissions. A batch is a snapshot of eligible entries when you click **Block all**; later discoveries are not added automatically.
- Continues an explicitly submitted batch when the popup closes or the page changes, provided an eligible `www.bilibili.com` tab remains open. Progress is stored for the browser session. After the background worker restarts, it checks in-progress relationships before continuing to avoid duplicate submissions.

The extension only identifies explicit promotion signals. It does not analyze audio or video, infer sponsorship from titles, or hide videos locally. Local hiding applies to independent webpage advertisements, not player overlays or ads embedded in the video itself. Bilibili controls recommendation behavior after an account is blacklisted.

Confirmed pure advertisements are hidden locally and counted separately in the popup. They do not appear in the uploader list or its badge, even as unknown-uploader entries, and count changes do not automatically open the popup. Hiding does not submit a blacklist request or block network downloads. Recognition requires an explicit promotion marker with a clear non-video destination, or rendered advertising material in a known independent ad slot. Missing, loading, short-link, and conflicting destinations remain unclassified; a failed video lookup alone never triggers hiding. Containers with nested independent cards or video destinations are preserved to avoid hiding normal content. A confirmed video promotion whose uploader lookup fails can still show the lookup error; it cannot be blocked until its uploader is verified.

The extension preserves the site's DOM and original styles while hiding confirmed ads. It rechecks changing cards and restores them if they become ordinary content, and clears its hiding markers on page-route changes. Supported ad selectors may need updates when Bilibili changes its markup; this is not a guarantee that every advertisement will be hidden.

A commercial disclosure on the main video must agree with the page's video identity metadata. If that metadata is missing, or an old disclosure remains during navigation, the extension conservatively skips that main-video association to avoid blocking the wrong uploader. Recommendation cards are detected separately.

## Install and use

Requires **Chrome 127 or later**.

1. Download a ZIP from [Releases](https://github.com/JasonLeon01/ACTrashBlocker/releases) and extract it, or use the `extension` directory from the source checkout.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the directory that **directly contains `manifest.json`**. For a source checkout, select `extension`, not the repository root. Do not select the ZIP file itself.
4. Open Chrome's extensions menu and pin **ACTrashBlocker** to the toolbar.
5. Open or reload the Bilibili homepage or a video page. Wait for promotion detection, or click the extension icon to view the current page's list.
6. Review the list, then use an entry's **Block** control or **Block all**. These actions modify the blacklist of the Bilibili account currently signed in to that browser profile.

Automatic opening uses Chrome's `action.openPopup()`. Chrome closes extension popups when they lose focus. If an automatic opening is unavailable, the badge still updates and you can open the popup manually. Background tabs do not interrupt the active tab.

After updating the source or replacing files in the extracted directory, reload the extension on `chrome://extensions`, then reload any already-open Bilibili pages.

## Sign-in, progress, and failures

- Detection works while signed out. Blocking requires a Bilibili session in the same Chrome profile. The extension reuses that session without asking for your password or persisting login cookies or CSRF values.
- Authenticated requests run through an isolated content script in an open `www.bilibili.com` tab, using the website's normal request origin and session. Keep a Bilibili homepage or video tab open. If all eligible tabs close, the batch pauses; reopen or refresh a Bilibili page before resuming. Reload existing Bilibili tabs after updating the extension so the request handler is available.
- A request rejection is different from a signed-out account. HTTP 403/412 indicate a rejected request, and HTTP 429 indicates rate limiting. Errors identify the failing operation and status. If login verification is unavailable, the popup retains the last known account and disables new block requests until verification succeeds.
- Each entry shows a pending, processing, blocked, or failed state. Failures include an explanation and are not reported as successful blocks.
- Expired authentication, an account change, or a risk-control response pauses the batch. Resolve sign-in or verification on Bilibili, then resume from the popup when prompted. A different account cannot resume another account's batch.
- Canceling pending tasks stops items that have not yet been executed. It does not undo completed blocks. Use Bilibili's own blacklist management to unblock an account.
- Ending the browser session clears extension session state. Blocks already applied to your Bilibili account remain in effect.

Blocking uses Bilibili's website endpoints and verifies the resulting account relationship. These are not public developer APIs with a promised compatibility contract. Changes to page markup, endpoints, cookie policies, or risk controls can affect detection or blocking. The extension reports failures and does not bypass verification challenges or retry indefinitely.

## Validate and package locally

Requires **Node.js 24+** and **Python 3.12+**. No npm or pip dependencies are needed. Run these commands from the repository root:

```sh
python3 scripts/package.py --check
python3 scripts/package.py
```

The first command validates the Manifest version, permissions, resource references, and JavaScript syntax without producing a package. The second performs the same checks, then generates:

```text
dist/ACTrashBlocker-v0.1.0.zip
dist/ACTrashBlocker-v0.1.0.zip.sha256
```

The version is read from `extension/manifest.json`. The ZIP contains only runtime resources referenced by the Manifest, HTML, CSS, and JavaScript, with `manifest.json` at its root. Repository documentation, CI configuration, packaging scripts, test files, and credentials are excluded. Archive ordering and timestamps are fixed so identical inputs produce reproducible packages. The `dist` directory is ignored by Git.

On macOS, verify a downloaded or locally generated checksum from the output directory:

```sh
cd dist
shasum -a 256 -c ACTrashBlocker-v0.1.0.zip.sha256
```

To choose another output location:

```sh
python3 scripts/package.py --output-dir /path/to/output
```

Packages are ZIP files, not self-signed CRX files, so no signing private key is required. Ordinary Chrome installations on macOS restrict installation of self-hosted CRX files; use the unpacked installation steps above.

## GitHub Actions and releases

The workflow is defined in `.github/workflows/build.yml`. Pushes, pull requests, and manual runs build the extension using Ubuntu, Node.js 24, and Python 3.12.

### Build artifacts

The build job uses read-only repository permissions. It runs the same local packaging script, stops on validation failure, and uploads the ZIP and SHA-256 file as an Actions artifact retained for **30 days**. The run summary includes the package version, download link, and installation instructions.

For ordinary branch pushes, pull requests, and manual runs, the workflow only produces these artifacts. To download one, open [Actions](https://github.com/JasonLeon01/ACTrashBlocker/actions), select a successful run, and download `ACTrashBlocker-v<version>` from **Artifacts**. GitHub may wrap the files in an outer archive: extract it first, then extract the plugin ZIP and load the directory that contains `manifest.json`.

### Releases from version tags

Pushing a version tag publishes a regular, non-draft GitHub Release after the build succeeds. Both of these tag formats are accepted:

- `v<manifest-version>`, for example `v0.1.0`.
- `<manifest-version>`, for example `0.1.0`.

The tag version must exactly match `version` in `extension/manifest.json`. A mismatch fails the release workflow instead of publishing a package under the wrong version.

To publish a version, first update the Manifest version, validate the package, and commit the release-ready source yourself. Then create and push the corresponding tag. For version `0.1.0`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

These commands are release instructions for the maintainer; the build script does not create, commit, or push tags.

The tag-only release job has `contents: write` permission and uses GitHub's built-in `GITHUB_TOKEN`. It attaches `ACTrashBlocker-v<version>.zip` and its `.zip.sha256` file to the [Release](https://github.com/JasonLeon01/ACTrashBlocker/releases). Release assets provide a durable download location and are not subject to the Actions artifact's 30-day retention. Rerunning the workflow adds or updates the generated assets on an existing release while preserving its existing title and notes, including manual edits. If a previous attempt left a draft, the rerun publishes it after uploading the assets successfully. Repositories with immutable releases enabled require a new version instead of replacing published assets.

No additional secrets, Chrome Web Store credentials, or signing keys are required. The workflow does not publish to the Chrome Web Store, commit generated packages to the repository, or access your Bilibili account. Remote build and release success should be checked in the actual Actions run after the relevant push.

## Project layout and permissions

```text
extension/                  Loadable extension runtime
  manifest.json             Manifest V3 configuration and permissions
  detector.js               Promotion, video destination, and display-ad detection
  content.js                Page scanning, local ad hiding, and candidate messages
  ad-hide.css               Styles scoped to confirmed display-ad containers
  site-api.js               Isolated site-context requests and actor checks
  site-transport.js         Fixed-operation messages to eligible Bilibili tabs
  background.js             Identity checks, session state, queues, and badges
  api.js / core.js           Fixed website endpoints and state processing
  popup.html/js/css         Toolbar interface
  icons/                    Extension icons
scripts/package.py          Shared validation and packaging entry point
.github/workflows/build.yml Build and tag-release workflow
```

| Permission or host | Purpose |
| --- | --- |
| `storage` | Store current-page candidates and task progress for the browser session. |
| `cookies` | Observe authentication changes and pause tasks when the account changes. CSRF values are read only inside the isolated site handler and are never returned to the background worker. |
| `alarms` | Check queue recovery after the background worker is suspended. |
| `www.bilibili.com` | Load content scripts in top-level Bilibili pages; scanning is limited to the homepage and video pages. |
| `api.bilibili.com` | Query video uploaders and authentication or relationship state, and submit blocks explicitly requested through the popup. |

Detection data and task state are processed locally. Website requests are sent only to Bilibili; there are no analytics services or remote scripts. Automated development checks use simulated responses rather than blocking real accounts. Temporary test code and fixtures are removed after validation; permanent packaging checks remain in the build script.

## Official references

- [Load an unpacked Chrome extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome Action API and automatic popups](https://developer.chrome.com/docs/extensions/reference/api/action)
- [Chrome extension distribution options](https://developer.chrome.com/docs/extensions/how-to/distribute)
- [GitHub Actions workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
