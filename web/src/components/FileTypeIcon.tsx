import fileIcon from 'material-icon-theme/icons/file.svg?url'
import consoleIcon from 'material-icon-theme/icons/console.svg?url'
import cssIcon from 'material-icon-theme/icons/css.svg?url'
import databaseIcon from 'material-icon-theme/icons/database.svg?url'
import dockerIcon from 'material-icon-theme/icons/docker.svg?url'
import gitIcon from 'material-icon-theme/icons/git.svg?url'
import goIcon from 'material-icon-theme/icons/go.svg?url'
import htmlIcon from 'material-icon-theme/icons/html.svg?url'
import imageIcon from 'material-icon-theme/icons/image.svg?url'
import javascriptIcon from 'material-icon-theme/icons/javascript.svg?url'
import jsonIcon from 'material-icon-theme/icons/json.svg?url'
import makefileIcon from 'material-icon-theme/icons/makefile.svg?url'
import markdownIcon from 'material-icon-theme/icons/markdown.svg?url'
import pdfIcon from 'material-icon-theme/icons/pdf.svg?url'
import pythonIcon from 'material-icon-theme/icons/python.svg?url'
import reactIcon from 'material-icon-theme/icons/react.svg?url'
import reactTsIcon from 'material-icon-theme/icons/react_ts.svg?url'
import rustIcon from 'material-icon-theme/icons/rust.svg?url'
import sassIcon from 'material-icon-theme/icons/sass.svg?url'
import settingsIcon from 'material-icon-theme/icons/settings.svg?url'
import tomlIcon from 'material-icon-theme/icons/toml.svg?url'
import typescriptIcon from 'material-icon-theme/icons/typescript.svg?url'
import xmlIcon from 'material-icon-theme/icons/xml.svg?url'
import yamlIcon from 'material-icon-theme/icons/yaml.svg?url'
import { cn } from '@/lib/utils'

const ICON_BY_EXTENSION: Record<string, string> = {
  py: pythonIcon,
  ts: typescriptIcon,
  tsx: reactTsIcon,
  js: javascriptIcon,
  jsx: reactIcon,
  json: jsonIcon,
  md: markdownIcon,
  markdown: markdownIcon,
  css: cssIcon,
  scss: sassIcon,
  html: htmlIcon,
  yml: yamlIcon,
  yaml: yamlIcon,
  toml: tomlIcon,
  rs: rustIcon,
  go: goIcon,
  sql: databaseIcon,
  xml: xmlIcon,
  svg: imageIcon,
  png: imageIcon,
  jpg: imageIcon,
  jpeg: imageIcon,
  gif: imageIcon,
  webp: imageIcon,
  pdf: pdfIcon,
  env: settingsIcon,
  sh: consoleIcon,
  bash: consoleIcon,
  zsh: consoleIcon,
}

const ICON_BY_FILENAME: Record<string, string> = {
  makefile: makefileIcon,
  dockerfile: dockerIcon,
  '.env': settingsIcon,
  '.env.example': settingsIcon,
  '.gitignore': gitIcon,
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.env.example')) return 'env'
  const index = lower.lastIndexOf('.')
  return index >= 0 ? lower.slice(index + 1) : ''
}

export function FileTypeIcon({ name, className, size = 14 }: { name: string; className?: string; size?: number }) {
  const fileName = name.toLowerCase().split('/').pop() ?? name.toLowerCase()
  const src = ICON_BY_FILENAME[fileName] ?? ICON_BY_EXTENSION[extensionOf(fileName)] ?? fileIcon

  return <img src={src} alt="" className={cn('inline-block shrink-0 object-contain', className)} style={{ width: size, height: size }} aria-hidden="true" />
}
