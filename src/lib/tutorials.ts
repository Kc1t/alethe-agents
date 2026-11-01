import type { MessageKey } from './i18n'

export type TutorialVideo = {
  id: string
  title: string
  author: string
  language: 'pt-BR' | 'en'
  start?: number
  summary: MessageKey
}

export const TUTORIALS_CHANNEL_URL = 'https://www.youtube.com/@kc_1t'

export const TUTORIAL_VIDEOS: TutorialVideo[] = [
  {
    id: '8jvrucR7QCU',
    title: 'Stop Using One AI Agent at a Time: Orchestrate AI Agents',
    author: 'Kauã Miguel - Dev',
    language: 'pt-BR',
    start: 54,
    summary: 'tutorials.summaryOrchestrate',
  },
  {
    id: 'ujW-e6w3NQA',
    title: 'How to Orchestrate AI Agents with a FREE Skill',
    author: 'Kauã Miguel - Dev',
    language: 'pt-BR',
    summary: 'tutorials.summarySkill',
  },
  {
    id: 'reUN7CkMbgM',
    title: 'A Day in the Life of a Software Developer — Devlog 1',
    author: 'Guilherme Dev',
    language: 'pt-BR',
    start: 100,
    summary: 'tutorials.summaryDevlog',
  },
]

export function watchUrl(video: TutorialVideo): string {
  const start = video.start ? `&t=${video.start}s` : ''
  return `https://www.youtube.com/watch?v=${video.id}${start}`
}

export function embedUrl(video: TutorialVideo): string {
  const start = video.start ? `&start=${video.start}` : ''
  return `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0${start}`
}

export function thumbnailUrl(video: TutorialVideo): string {
  return `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
}
