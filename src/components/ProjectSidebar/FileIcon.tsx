import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCode2,
  FileImage,
  FileJson,
  FileKey,
  FileSliders,
  FileSpreadsheet,
  FileText,
  FileVideo,
  GitBranch,
  Terminal,
} from 'lucide-react'

type FileIconProps = {
  fileName: string
  size?: number
  className?: string
}

export function FileIcon({ fileName, size = 13, className }: FileIconProps) {
  const lower = fileName.toLowerCase()

  // Dotfiles & special names
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules') {
    return <GitBranch size={size} className={className} />
  }
  if (lower === 'dockerfile' || lower.startsWith('docker-compose') || lower === '.dockerignore') {
    return <FileCode2 size={size} className={className} />
  }
  if (lower === '.env' || lower.startsWith('.env.')) {
    return <FileKey size={size} className={className} />
  }
  if (lower.endsWith('.json')) {
    return <FileJson size={size} className={className} />
  }
  if (
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.ini')
  ) {
    return <FileSliders size={size} className={className} />
  }
  if (lower.endsWith('.sql') || lower.endsWith('.db') || lower.endsWith('.sqlite')) {
    return <Database size={size} className={className} />
  }
  if (
    lower.endsWith('.sh') ||
    lower.endsWith('.bash') ||
    lower.endsWith('.zsh') ||
    lower.endsWith('.ps1') ||
    lower.endsWith('.bat') ||
    lower.endsWith('.cmd')
  ) {
    return <Terminal size={size} className={className} />
  }
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.py') ||
    lower.endsWith('.rs') ||
    lower.endsWith('.go') ||
    lower.endsWith('.c') ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.h') ||
    lower.endsWith('.hpp') ||
    lower.endsWith('.cs') ||
    lower.endsWith('.java') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.css') ||
    lower.endsWith('.scss') ||
    lower.endsWith('.less')
  ) {
    return <FileCode size={size} className={className} />
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.ico') ||
    lower.endsWith('.bmp') ||
    lower.endsWith('.avif')
  ) {
    return <FileImage size={size} className={className} />
  }
  if (
    lower.endsWith('.mp4') ||
    lower.endsWith('.mov') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.m4v') ||
    lower.endsWith('.ogv')
  ) {
    return <FileVideo size={size} className={className} />
  }
  if (
    lower.endsWith('.mp3') ||
    lower.endsWith('.wav') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.flac') ||
    lower.endsWith('.aac')
  ) {
    return <FileAudio size={size} className={className} />
  }
  if (
    lower.endsWith('.csv') ||
    lower.endsWith('.tsv') ||
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls')
  ) {
    return <FileSpreadsheet size={size} className={className} />
  }
  if (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.gz') ||
    lower.endsWith('.7z') ||
    lower.endsWith('.rar')
  ) {
    return <FileArchive size={size} className={className} />
  }
  if (
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.mdx') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.pdf')
  ) {
    return <FileText size={size} className={className} />
  }

  return <File size={size} className={className} />
}
