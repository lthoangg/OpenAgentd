/**
 * Extensions (lowercase, no dot) of files the UI treats as text: the file
 * viewer reads and highlights them, the attachment strip previews them, and
 * the composer's file picker offers them.
 *
 * One list on purpose — separate copies drifted, so a ``.jsonl`` or
 * ``.astro`` file worked in one surface and not another.
 */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Docs
  'txt', 'md', 'markdown', 'mdx', 'rst', 'tex', 'log',
  // Data / config
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'ipynb',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'gitignore', 'lock', 'csv', 'tsv',
  'xml', 'xsd', 'plist', 'svg',
  // Web
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'astro', 'svelte', 'vue', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'styl',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Languages
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'c', 'h', 'cc', 'cxx', 'cpp', 'hpp', 'cs', 'fs', 'swift', 'm', 'mm',
  'php', 'rb', 'lua', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'jl', 'ml',
  'elm', 'nim', 'nix', 'zig', 'r', 'pl', 'sol', 'vim',
  // Query / schema / infra
  'sql', 'prisma', 'graphql', 'gql', 'proto', 'tf', 'tfvars', 'hcl',
  'dockerfile', 'mk', 'diff', 'patch',
])
