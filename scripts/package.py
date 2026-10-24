#!/usr/bin/env python3
"""Validate the extension and create a reproducible, runtime-files-only ZIP."""

from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit
import zipfile


ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "extension"
ALLOWED_SUFFIXES = {".json", ".js", ".html", ".css", ".png", ".svg", ".webp", ".woff2"}
EXPECTED_PERMISSIONS = {"storage", "cookies", "alarms"}
EXPECTED_HOSTS = {"https://www.bilibili.com/*", "https://api.bilibili.com/*"}
JS_IMPORT = re.compile(
    r"(?:\b(?:import|export)\s+(?:[^;\"']*?\s+from\s+)?[\"']([^\"']+)[\"']"
    r"|\bimport\s*\(\s*[\"']([^\"']+)[\"']\s*\)"
    r"|\bchrome\.runtime\.getURL\(\s*[\"']([^\"']+)[\"']\s*\))"
)
CSS_REFERENCE = re.compile(r"url\(\s*[\"']?([^\s\)\"']+)[\"']?\s*\)|@import\s+[\"']([^\"']+)[\"']")


class InvalidPackage(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise InvalidPackage(message)


def resolve_resource(base: Path, reference: str) -> Path | None:
    parts = urlsplit(reference)
    if reference.startswith("#") or parts.scheme == "data":
        return None
    require(not parts.scheme and not parts.netloc, f"Remote runtime resources are not allowed: {reference}")
    decoded = unquote(parts.path)
    require(bool(decoded) and "\\" not in decoded, f"Invalid resource path: {reference}")
    relative = PurePosixPath(decoded)
    require(not relative.is_absolute(), f"Resources must use relative paths: {reference}")
    raw_path = base / Path(*relative.parts)
    path = raw_path.resolve()
    require(path.is_relative_to(EXTENSION.resolve()), f"Resource escapes the extension directory: {reference}")
    for parent in [raw_path, *raw_path.parents]:
        if parent == EXTENSION.parent:
            break
        require(not parent.is_symlink(), f"Symbolic links cannot be packaged: {reference}")
    require(path.is_file(), f"Referenced resource is missing: {reference}")
    require(path.suffix in ALLOWED_SUFFIXES, f"Unsupported runtime resource type: {reference}")
    require(not any(part.startswith(".") or part.lower() in {"tests", "test", "fixtures", "node_modules", "__pycache__"} for part in path.relative_to(EXTENSION).parts), f"Test and hidden files cannot be packaged: {reference}")
    require(not re.search(r"(?:^|[._-])(test|spec|fixture)(?:[._-]|$)", path.name, re.I), f"Test files cannot be packaged: {reference}")
    return path


class ResourceHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        require(not any(name.lower().startswith("on") for name in attributes), "HTML must not contain inline event handlers")
        if tag == "script":
            require(bool(attributes.get("src")), "HTML must not contain inline JavaScript")
        if tag in {"script", "img", "source", "video", "audio", "iframe"} and attributes.get("src"):
            self.references.append(attributes["src"])
        if tag == "link" and attributes.get("href") and attributes.get("rel") in {"stylesheet", "icon", "preload", "modulepreload"}:
            self.references.append(attributes["href"])


def validate() -> tuple[dict, list[Path]]:
    manifest_path = EXTENSION / "manifest.json"
    require(manifest_path.is_file() and not manifest_path.is_symlink(), "Missing extension/manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("manifest_version") == 3, "Manifest V3 is required")
    require(bool(manifest.get("name")) and len(manifest["name"]) <= 75, "Invalid extension name in manifest")
    version = manifest.get("version", "")
    require(isinstance(version, str) and re.fullmatch(r"(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}", version) is not None, "Manifest version must contain 1-4 nonnegative integer components without leading zeros")
    numbers = [int(part) for part in version.split(".")]
    require(any(numbers) and all(number <= 65535 for number in numbers), "Manifest version components must be 0-65535 and must not all be zero")
    require(manifest.get("minimum_chrome_version") == "127", "The minimum Chrome version must be 127")
    require(set(manifest.get("permissions", [])) == EXPECTED_PERMISSIONS, "Permissions must be limited to storage, cookies, and alarms")
    require(set(manifest.get("host_permissions", [])) == EXPECTED_HOSTS, "Host permissions must be limited to Bilibili pages and its API")
    require(not manifest.get("optional_permissions") and not manifest.get("optional_host_permissions") and not manifest.get("externally_connectable"), "Additional permissions and external messaging are not allowed")
    require(manifest.get("background", {}).get("type") == "module", "The background service worker must use modules")
    require(manifest.get("content_security_policy", {}).get("extension_pages") == "script-src 'self'; object-src 'self'", "The extension CSP must restrict scripts and objects to local resources")

    references = [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]
    references += list(manifest.get("icons", {}).values())
    references += list(manifest["action"].get("default_icon", {}).values())
    scripts = manifest.get("content_scripts", [])
    require(bool(scripts), "Content scripts must be configured")
    for script in scripts:
        require(script.get("matches") == ["https://www.bilibili.com/*"] and not script.get("all_frames", False), "Content scripts must run only in top-level Bilibili pages")
        require(script.get("run_at") == "document_idle", "Content scripts must load at document_idle")
        references += script.get("js", []) + script.get("css", [])

    included = {manifest_path.resolve()}
    pending = [(EXTENSION, reference) for reference in references]
    while pending:
        base, reference = pending.pop()
        path = resolve_resource(base, reference)
        if path is None or path in included:
            continue
        included.add(path)
        if path.suffix == ".html":
            parser = ResourceHTMLParser()
            parser.feed(path.read_text(encoding="utf-8"))
            pending.extend((path.parent, ref) for ref in parser.references)
        elif path.suffix == ".css":
            pending.extend((path.parent, next(value for value in match.groups() if value)) for match in CSS_REFERENCE.finditer(path.read_text(encoding="utf-8")))
        elif path.suffix == ".js":
            for match in JS_IMPORT.finditer(path.read_text(encoding="utf-8")):
                ref = next(value for value in match.groups() if value)
                pending.append((EXTENSION if match.group(3) else path.parent, ref))

    node = shutil.which("node")
    require(node is not None, "Node.js 24 or later is required for syntax checks")
    node_version = subprocess.run([node, "--version"], text=True, capture_output=True, check=True).stdout.strip()
    require(int(node_version.lstrip("v").split(".")[0]) >= 24, f"Node.js 24 or later is required; found {node_version}")
    for path in sorted(included):
        if path.suffix == ".js":
            result = subprocess.run([node, "--check", str(path)], text=True, capture_output=True)
            require(result.returncode == 0, f"JavaScript syntax error in {path.relative_to(EXTENSION)}:\n{result.stderr}")
    return manifest, sorted(included)


def package(manifest: dict, files: list[Path], output: Path) -> tuple[Path, Path]:
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"ACTrashBlocker-v{manifest['version']}.zip"
    with tempfile.NamedTemporaryFile(dir=output, suffix=".zip", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
            for path in files:
                info = zipfile.ZipInfo(path.relative_to(EXTENSION).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                bundle.writestr(info, path.read_bytes(), compresslevel=9)
        with zipfile.ZipFile(temporary) as bundle:
            require(bundle.testzip() is None, "ZIP integrity check failed")
            require("manifest.json" in bundle.namelist(), "The ZIP root must contain manifest.json")
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
    checksum = archive.with_suffix(".zip.sha256")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return archive, checksum


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate source files and resources without producing an archive")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist", help="Output directory for the ZIP and SHA-256 checksum")
    args = parser.parse_args()
    try:
        manifest, files = validate()
        print(f"Validation passed: v{manifest['version']}, {len(files)} runtime files")
        if not args.check:
            archive, checksum = package(manifest, files, args.output_dir.resolve())
            print(f"Extension package: {archive}\nChecksum file: {checksum}")
        return 0
    except (InvalidPackage, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
