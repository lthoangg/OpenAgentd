/**
 * resolveFileIcon — pure filename → icon URL lookup.
 *
 * Separated from the FileTypeIcon component so it can be imported in tests
 * without triggering the react-refresh/only-export-components lint rule
 * (a file that exports both a component and a non-component function is
 * flagged by that rule).
 *
 * The mappings follow material-icon-theme's own manifest
 * (``dist/material-icons.json``) for a curated set of popular files; each
 * icon is a separate asset, so the whole 1,200-icon set is not imported.
 * ``no-inline`` keeps them out of the startup bundle: Vite would otherwise
 * inline each small SVG as a data URI in the index chunk (~77 kB for this
 * set), while as files they are fetched once and cached by hashed name.
 *
 * The SVG ``?url&no-inline`` imports are Vite-only; in tests they are stubbed via
 * mock.module in setup.ts, which scans this file for the specifiers and
 * returns "stub:<name>.svg" strings.
 */

import fileIcon from 'material-icon-theme/icons/file.svg?url&no-inline'
import agentIcon from 'material-icon-theme/icons/agent.svg?url&no-inline'
import assemblyIcon from 'material-icon-theme/icons/assembly.svg?url&no-inline'
import astroConfigIcon from 'material-icon-theme/icons/astro-config.svg?url&no-inline'
import astroIcon from 'material-icon-theme/icons/astro.svg?url&no-inline'
import audioIcon from 'material-icon-theme/icons/audio.svg?url&no-inline'
import biomeIcon from 'material-icon-theme/icons/biome.svg?url&no-inline'
import bunIcon from 'material-icon-theme/icons/bun.svg?url&no-inline'
import cIcon from 'material-icon-theme/icons/c.svg?url&no-inline'
import certificateIcon from 'material-icon-theme/icons/certificate.svg?url&no-inline'
import changelogIcon from 'material-icon-theme/icons/changelog.svg?url&no-inline'
import claudeIcon from 'material-icon-theme/icons/claude.svg?url&no-inline'
import clojureIcon from 'material-icon-theme/icons/clojure.svg?url&no-inline'
import cmakeIcon from 'material-icon-theme/icons/cmake.svg?url&no-inline'
import consoleIcon from 'material-icon-theme/icons/console.svg?url&no-inline'
import cppIcon from 'material-icon-theme/icons/cpp.svg?url&no-inline'
import csharpIcon from 'material-icon-theme/icons/csharp.svg?url&no-inline'
import cssIcon from 'material-icon-theme/icons/css.svg?url&no-inline'
import dartIcon from 'material-icon-theme/icons/dart.svg?url&no-inline'
import databaseIcon from 'material-icon-theme/icons/database.svg?url&no-inline'
import denoIcon from 'material-icon-theme/icons/deno.svg?url&no-inline'
import diffIcon from 'material-icon-theme/icons/diff.svg?url&no-inline'
import dockerIcon from 'material-icon-theme/icons/docker.svg?url&no-inline'
import documentIcon from 'material-icon-theme/icons/document.svg?url&no-inline'
import editorconfigIcon from 'material-icon-theme/icons/editorconfig.svg?url&no-inline'
import elixirIcon from 'material-icon-theme/icons/elixir.svg?url&no-inline'
import elmIcon from 'material-icon-theme/icons/elm.svg?url&no-inline'
import erlangIcon from 'material-icon-theme/icons/erlang.svg?url&no-inline'
import eslintIcon from 'material-icon-theme/icons/eslint.svg?url&no-inline'
import fontIcon from 'material-icon-theme/icons/font.svg?url&no-inline'
import fsharpIcon from 'material-icon-theme/icons/fsharp.svg?url&no-inline'
import gitIcon from 'material-icon-theme/icons/git.svg?url&no-inline'
import goModIcon from 'material-icon-theme/icons/go-mod.svg?url&no-inline'
import goIcon from 'material-icon-theme/icons/go.svg?url&no-inline'
import gradleIcon from 'material-icon-theme/icons/gradle.svg?url&no-inline'
import graphqlIcon from 'material-icon-theme/icons/graphql.svg?url&no-inline'
import groovyIcon from 'material-icon-theme/icons/groovy.svg?url&no-inline'
import hIcon from 'material-icon-theme/icons/h.svg?url&no-inline'
import haskellIcon from 'material-icon-theme/icons/haskell.svg?url&no-inline'
import hclIcon from 'material-icon-theme/icons/hcl.svg?url&no-inline'
import hppIcon from 'material-icon-theme/icons/hpp.svg?url&no-inline'
import htmlIcon from 'material-icon-theme/icons/html.svg?url&no-inline'
import imageIcon from 'material-icon-theme/icons/image.svg?url&no-inline'
import javaIcon from 'material-icon-theme/icons/java.svg?url&no-inline'
import javascriptIcon from 'material-icon-theme/icons/javascript.svg?url&no-inline'
import jsonIcon from 'material-icon-theme/icons/json.svg?url&no-inline'
import jsconfigIcon from 'material-icon-theme/icons/jsconfig.svg?url&no-inline'
import juliaIcon from 'material-icon-theme/icons/julia.svg?url&no-inline'
import jupyterIcon from 'material-icon-theme/icons/jupyter.svg?url&no-inline'
import keyIcon from 'material-icon-theme/icons/key.svg?url&no-inline'
import kotlinIcon from 'material-icon-theme/icons/kotlin.svg?url&no-inline'
import lessIcon from 'material-icon-theme/icons/less.svg?url&no-inline'
import licenseIcon from 'material-icon-theme/icons/license.svg?url&no-inline'
import lockIcon from 'material-icon-theme/icons/lock.svg?url&no-inline'
import logIcon from 'material-icon-theme/icons/log.svg?url&no-inline'
import luaIcon from 'material-icon-theme/icons/lua.svg?url&no-inline'
import makefileIcon from 'material-icon-theme/icons/makefile.svg?url&no-inline'
import markdownIcon from 'material-icon-theme/icons/markdown.svg?url&no-inline'
import mdxIcon from 'material-icon-theme/icons/mdx.svg?url&no-inline'
import nextIcon from 'material-icon-theme/icons/next.svg?url&no-inline'
import nimIcon from 'material-icon-theme/icons/nim.svg?url&no-inline'
import nixIcon from 'material-icon-theme/icons/nix.svg?url&no-inline'
import nodejsIcon from 'material-icon-theme/icons/nodejs.svg?url&no-inline'
import npmIcon from 'material-icon-theme/icons/npm.svg?url&no-inline'
import objectiveCIcon from 'material-icon-theme/icons/objective-c.svg?url&no-inline'
import objectiveCppIcon from 'material-icon-theme/icons/objective-cpp.svg?url&no-inline'
import ocamlIcon from 'material-icon-theme/icons/ocaml.svg?url&no-inline'
import pdfIcon from 'material-icon-theme/icons/pdf.svg?url&no-inline'
import perlIcon from 'material-icon-theme/icons/perl.svg?url&no-inline'
import phpIcon from 'material-icon-theme/icons/php.svg?url&no-inline'
import pnpmIcon from 'material-icon-theme/icons/pnpm.svg?url&no-inline'
import poetryIcon from 'material-icon-theme/icons/poetry.svg?url&no-inline'
import powerpointIcon from 'material-icon-theme/icons/powerpoint.svg?url&no-inline'
import powershellIcon from 'material-icon-theme/icons/powershell.svg?url&no-inline'
import prettierIcon from 'material-icon-theme/icons/prettier.svg?url&no-inline'
import prismaIcon from 'material-icon-theme/icons/prisma.svg?url&no-inline'
import protoIcon from 'material-icon-theme/icons/proto.svg?url&no-inline'
import pythonMiscIcon from 'material-icon-theme/icons/python-misc.svg?url&no-inline'
import pythonIcon from 'material-icon-theme/icons/python.svg?url&no-inline'
import rIcon from 'material-icon-theme/icons/r.svg?url&no-inline'
import reactIcon from 'material-icon-theme/icons/react.svg?url&no-inline'
import reactTsIcon from 'material-icon-theme/icons/react_ts.svg?url&no-inline'
import readmeIcon from 'material-icon-theme/icons/readme.svg?url&no-inline'
import rubyIcon from 'material-icon-theme/icons/ruby.svg?url&no-inline'
import rustIcon from 'material-icon-theme/icons/rust.svg?url&no-inline'
import sassIcon from 'material-icon-theme/icons/sass.svg?url&no-inline'
import scalaIcon from 'material-icon-theme/icons/scala.svg?url&no-inline'
import settingsIcon from 'material-icon-theme/icons/settings.svg?url&no-inline'
import solidityIcon from 'material-icon-theme/icons/solidity.svg?url&no-inline'
import stylusIcon from 'material-icon-theme/icons/stylus.svg?url&no-inline'
import svelteIcon from 'material-icon-theme/icons/svelte.svg?url&no-inline'
import swiftIcon from 'material-icon-theme/icons/swift.svg?url&no-inline'
import tableIcon from 'material-icon-theme/icons/table.svg?url&no-inline'
import tailwindcssIcon from 'material-icon-theme/icons/tailwindcss.svg?url&no-inline'
import terraformIcon from 'material-icon-theme/icons/terraform.svg?url&no-inline'
import testJsIcon from 'material-icon-theme/icons/test-js.svg?url&no-inline'
import testJsxIcon from 'material-icon-theme/icons/test-jsx.svg?url&no-inline'
import testTsIcon from 'material-icon-theme/icons/test-ts.svg?url&no-inline'
import texIcon from 'material-icon-theme/icons/tex.svg?url&no-inline'
import tomlIcon from 'material-icon-theme/icons/toml.svg?url&no-inline'
import tsconfigIcon from 'material-icon-theme/icons/tsconfig.svg?url&no-inline'
import typescriptDefIcon from 'material-icon-theme/icons/typescript-def.svg?url&no-inline'
import typescriptIcon from 'material-icon-theme/icons/typescript.svg?url&no-inline'
import uvIcon from 'material-icon-theme/icons/uv.svg?url&no-inline'
import verilogIcon from 'material-icon-theme/icons/verilog.svg?url&no-inline'
import videoIcon from 'material-icon-theme/icons/video.svg?url&no-inline'
import viteIcon from 'material-icon-theme/icons/vite.svg?url&no-inline'
import vitestIcon from 'material-icon-theme/icons/vitest.svg?url&no-inline'
import vimIcon from 'material-icon-theme/icons/vim.svg?url&no-inline'
import vueIcon from 'material-icon-theme/icons/vue.svg?url&no-inline'
import webassemblyIcon from 'material-icon-theme/icons/webassembly.svg?url&no-inline'
import wordIcon from 'material-icon-theme/icons/word.svg?url&no-inline'
import xmlIcon from 'material-icon-theme/icons/xml.svg?url&no-inline'
import yamlIcon from 'material-icon-theme/icons/yaml.svg?url&no-inline'
import yarnIcon from 'material-icon-theme/icons/yarn.svg?url&no-inline'
import zigIcon from 'material-icon-theme/icons/zig.svg?url&no-inline'
import zipIcon from 'material-icon-theme/icons/zip.svg?url&no-inline'

/**
 * Keys are lowercase extensions without the leading dot. Multi-part keys
 * (``d.ts``, ``test.ts``) win over their last part — see ``resolveFileIcon``.
 */
const ICON_BY_EXTENSION: Record<string, string> = {
  // JavaScript / TypeScript
  ts: typescriptIcon, mts: typescriptIcon, cts: typescriptIcon,
  'd.ts': typescriptDefIcon, 'd.mts': typescriptDefIcon, 'd.cts': typescriptDefIcon,
  tsx: reactTsIcon,
  js: javascriptIcon, mjs: javascriptIcon, cjs: javascriptIcon,
  jsx: reactIcon,
  'test.ts': testTsIcon, 'spec.ts': testTsIcon,
  'test.js': testJsIcon, 'spec.js': testJsIcon,
  'test.tsx': testJsxIcon, 'spec.tsx': testJsxIcon,
  'test.jsx': testJsxIcon, 'spec.jsx': testJsxIcon,
  // Web frameworks / markup / styles
  astro: astroIcon,
  svelte: svelteIcon,
  vue: vueIcon,
  html: htmlIcon, htm: htmlIcon, xhtml: htmlIcon,
  css: cssIcon,
  scss: sassIcon, sass: sassIcon,
  less: lessIcon,
  styl: stylusIcon,
  // Data / config
  json: jsonIcon, jsonc: jsonIcon, json5: jsonIcon, jsonl: jsonIcon, ndjson: jsonIcon,
  yml: yamlIcon, yaml: yamlIcon,
  toml: tomlIcon,
  xml: xmlIcon, xsd: xmlIcon, plist: xmlIcon,
  csv: tableIcon, tsv: tableIcon, xlsx: tableIcon, xls: tableIcon,
  ini: settingsIcon, cfg: settingsIcon, conf: settingsIcon, properties: settingsIcon,
  env: settingsIcon,
  lock: lockIcon,
  sql: databaseIcon, sqlite: databaseIcon, sqlite3: databaseIcon, db: databaseIcon,
  prisma: prismaIcon,
  graphql: graphqlIcon, gql: graphqlIcon,
  proto: protoIcon,
  tf: terraformIcon, tfvars: terraformIcon,
  hcl: hclIcon,
  // Docs
  md: markdownIcon, markdown: markdownIcon, mkd: markdownIcon, rst: markdownIcon,
  mdx: mdxIcon,
  txt: documentIcon,
  log: logIcon,
  tex: texIcon,
  pdf: pdfIcon,
  doc: wordIcon, docx: wordIcon,
  ppt: powerpointIcon, pptx: powerpointIcon,
  diff: diffIcon, patch: diffIcon,
  ipynb: jupyterIcon,
  // Languages
  py: pythonIcon, pyi: pythonIcon, pyw: pythonIcon,
  rs: rustIcon,
  go: goIcon,
  java: javaIcon,
  kt: kotlinIcon, kts: kotlinIcon,
  scala: scalaIcon, sc: scalaIcon,
  groovy: groovyIcon,
  gradle: gradleIcon,
  swift: swiftIcon,
  c: cIcon,
  h: hIcon,
  cpp: cppIcon, cc: cppIcon, cxx: cppIcon,
  hpp: hppIcon, hh: hppIcon, hxx: hppIcon,
  m: objectiveCIcon, mm: objectiveCppIcon,
  cs: csharpIcon,
  fs: fsharpIcon, fsx: fsharpIcon,
  php: phpIcon,
  rb: rubyIcon, rake: rubyIcon, gemspec: rubyIcon,
  lua: luaIcon,
  dart: dartIcon,
  ex: elixirIcon, exs: elixirIcon,
  erl: erlangIcon, hrl: erlangIcon,
  hs: haskellIcon,
  clj: clojureIcon, cljs: clojureIcon, cljc: clojureIcon,
  jl: juliaIcon,
  ml: ocamlIcon, mli: ocamlIcon,
  elm: elmIcon,
  nim: nimIcon,
  nix: nixIcon,
  zig: zigIcon,
  r: rIcon,
  pl: perlIcon, pm: perlIcon,
  sol: solidityIcon,
  v: verilogIcon, sv: verilogIcon, vhd: verilogIcon,
  asm: assemblyIcon, s: assemblyIcon,
  wasm: webassemblyIcon, wat: webassemblyIcon,
  vim: vimIcon,
  // Shell
  sh: consoleIcon, bash: consoleIcon, zsh: consoleIcon, fish: consoleIcon,
  bat: consoleIcon, cmd: consoleIcon,
  ps1: powershellIcon, psm1: powershellIcon,
  // Media / binary
  svg: imageIcon, png: imageIcon, jpg: imageIcon, jpeg: imageIcon, gif: imageIcon,
  webp: imageIcon, bmp: imageIcon, ico: imageIcon, avif: imageIcon, tif: imageIcon, tiff: imageIcon,
  mp3: audioIcon, wav: audioIcon, ogg: audioIcon, flac: audioIcon, m4a: audioIcon,
  mp4: videoIcon, mov: videoIcon, webm: videoIcon, mkv: videoIcon, avi: videoIcon,
  ttf: fontIcon, otf: fontIcon, woff: fontIcon, woff2: fontIcon,
  zip: zipIcon, tar: zipIcon, gz: zipIcon, tgz: zipIcon, '7z': zipIcon, rar: zipIcon,
  pem: keyIcon, key: keyIcon,
  crt: certificateIcon, cer: certificateIcon,
}

/** Exact (lowercase) filenames; these win over the extension. */
const ICON_BY_FILENAME: Record<string, string> = {
  makefile: makefileIcon,
  'cmakelists.txt': cmakeIcon,
  dockerfile: dockerIcon,
  '.dockerignore': dockerIcon,
  'docker-compose.yml': dockerIcon,
  'docker-compose.yaml': dockerIcon,
  'compose.yml': dockerIcon,
  'compose.yaml': dockerIcon,
  '.env': settingsIcon,
  '.env.example': settingsIcon,
  '.gitignore': gitIcon,
  '.gitattributes': gitIcon,
  '.gitmodules': gitIcon,
  '.gitkeep': gitIcon,
  readme: readmeIcon,
  'readme.md': readmeIcon,
  'readme.txt': readmeIcon,
  license: licenseIcon,
  'license.md': licenseIcon,
  'license.txt': licenseIcon,
  licence: licenseIcon,
  copying: licenseIcon,
  'changelog.md': changelogIcon,
  changelog: changelogIcon,
  'agents.md': agentIcon,
  'claude.md': claudeIcon,
  'package.json': nodejsIcon,
  'package-lock.json': nodejsIcon,
  '.nvmrc': nodejsIcon,
  '.npmrc': npmIcon,
  'yarn.lock': yarnIcon,
  '.yarnrc.yml': yarnIcon,
  'pnpm-lock.yaml': pnpmIcon,
  'pnpm-workspace.yaml': pnpmIcon,
  'bun.lock': bunIcon,
  'bun.lockb': bunIcon,
  'bunfig.toml': bunIcon,
  'deno.json': denoIcon,
  'deno.jsonc': denoIcon,
  'tsconfig.json': tsconfigIcon,
  'jsconfig.json': jsconfigIcon,
  'biome.json': biomeIcon,
  '.editorconfig': editorconfigIcon,
  '.prettierrc': prettierIcon,
  '.prettierrc.json': prettierIcon,
  'prettier.config.js': prettierIcon,
  '.eslintrc': eslintIcon,
  '.eslintrc.json': eslintIcon,
  '.eslintrc.js': eslintIcon,
  'eslint.config.js': eslintIcon,
  'eslint.config.mjs': eslintIcon,
  'eslint.config.ts': eslintIcon,
  'vite.config.ts': viteIcon,
  'vite.config.js': viteIcon,
  'vite.config.mjs': viteIcon,
  'vitest.config.ts': vitestIcon,
  'vitest.config.js': vitestIcon,
  'astro.config.mjs': astroConfigIcon,
  'astro.config.ts': astroConfigIcon,
  'astro.config.js': astroConfigIcon,
  'svelte.config.js': svelteIcon,
  'next.config.js': nextIcon,
  'next.config.mjs': nextIcon,
  'next.config.ts': nextIcon,
  'tailwind.config.js': tailwindcssIcon,
  'tailwind.config.ts': tailwindcssIcon,
  'go.mod': goModIcon,
  'go.sum': goModIcon,
  'cargo.toml': rustIcon,
  'cargo.lock': rustIcon,
  'pyproject.toml': pythonMiscIcon,
  'requirements.txt': pythonMiscIcon,
  '.python-version': pythonMiscIcon,
  'uv.lock': uvIcon,
  'poetry.lock': poetryIcon,
  gemfile: rubyIcon,
  'gemfile.lock': rubyIcon,
}

/**
 * Candidate extension keys for ``fileName``, longest first: ``a.test.ts``
 * yields ``test.ts`` then ``ts``. A leading dot is part of the name, not an
 * extension separator, so ``.bashrc`` has no extension.
 */
function extensionKeys(fileName: string): string[] {
  if (fileName.endsWith('.env.example')) return ['env']
  const keys: string[] = []
  for (let i = fileName.indexOf('.', 1); i >= 0; i = fileName.indexOf('.', i + 1)) {
    keys.push(fileName.slice(i + 1))
  }
  return keys
}

/** Returns the icon src URL for a given filename or path. */
export function resolveFileIcon(name: string): string {
  const fileName = name.toLowerCase().split('/').pop() ?? name.toLowerCase()
  const byName = ICON_BY_FILENAME[fileName]
  if (byName) return byName
  for (const key of extensionKeys(fileName)) {
    const byExtension = ICON_BY_EXTENSION[key]
    if (byExtension) return byExtension
  }
  // `.env.local`, `.env.production`, … share the `.env` icon.
  if (fileName.startsWith('.env.')) return settingsIcon
  return fileIcon
}
