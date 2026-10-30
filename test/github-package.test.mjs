import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { prepareGithubPackage } from "../scripts/prepare-github-package.mjs"

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orcaterm-github-package-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifest = { name: "opencode-orcaterm-auth", version: "0.2.9", main: "./index.mjs", files: ["index.mjs", "wechat.mjs"], ...overrides }
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest))
  fs.writeFileSync(path.join(directory, "index.mjs"), "export const source = 'published npm artifact'\n")
  fs.writeFileSync(path.join(directory, "wechat.mjs"), "export const callback = 'unchanged'\n")
  return { directory, manifest }
}

test("GitHub mirror changes only publishing metadata and preserves source bytes", t => {
  const { directory, manifest } = fixture(t)
  const files = ["index.mjs", "wechat.mjs"].map(name => [name, fs.readFileSync(path.join(directory, name))])
  assert.deepEqual(prepareGithubPackage(directory, "0.2.9"), { name: "@hg1048596-pixel/opencode-orcaterm-auth", version: "0.2.9" })
  const actual = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  assert.deepEqual(actual, { ...manifest, name: "@hg1048596-pixel/opencode-orcaterm-auth", repository: {
    type: "git", url: "git+https://github.com/hg1048596-pixel/opencode-orcaterm-auth.git",
  }, publishConfig: { registry: "https://npm.pkg.github.com" } })
  for (const [name, before] of files) assert.deepEqual(fs.readFileSync(path.join(directory, name)), before)
})

test("a mismatched source package is refused without changing the manifest", t => {
  for (const overrides of [{ name: "another-package" }, { version: "0.3.0" }]) {
    const { directory } = fixture(t, overrides)
    const before = fs.readFileSync(path.join(directory, "package.json"))
    assert.throws(() => prepareGithubPackage(directory, "0.2.9"), /does not match/)
    assert.deepEqual(fs.readFileSync(path.join(directory, "package.json")), before)
  }
})

test("invalid version input is refused before touching the package", () => {
  for (const version of ["latest", "../0.2.9", "0.2.9;echo", ""]) {
    assert.throws(() => prepareGithubPackage("unused", version), /Invalid package version/)
  }
})
