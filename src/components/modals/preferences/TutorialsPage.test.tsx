import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openInBrowser } from '../../../lib/tauri/filesystem'
import { TUTORIAL_VIDEOS, TUTORIALS_CHANNEL_URL } from '../../../lib/tutorials'
import { TutorialsPage } from './TutorialsPage'

vi.mock('../../../lib/tauri/filesystem', () => ({
  openInBrowser: vi.fn(async () => {}),
}))

describe('TutorialsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows every video as a poster until one is played', () => {
    render(<TutorialsPage />)
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
    for (const video of TUTORIAL_VIDEOS) expect(screen.getByText(video.title)).toBeTruthy()

    const [first] = TUTORIAL_VIDEOS
    fireEvent.click(screen.getByRole('button', { name: `Play ${first.title}` }))

    const frames = document.querySelectorAll('iframe')
    expect(frames).toHaveLength(1)
    expect(frames[0].getAttribute('src')).toBe(
      `https://www.youtube-nocookie.com/embed/${first.id}?autoplay=1&rel=0&start=${first.start}`,
    )
    expect(frames[0].getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
  })

  it('plays one video at a time', () => {
    render(<TutorialsPage />)
    const [first, second] = TUTORIAL_VIDEOS
    fireEvent.click(screen.getByRole('button', { name: `Play ${first.title}` }))
    fireEvent.click(screen.getByRole('button', { name: `Play ${second.title}` }))
    const frames = document.querySelectorAll('iframe')
    expect(frames).toHaveLength(1)
    expect(frames[0].getAttribute('src')).toContain(second.id)
  })

  it('opens a video or the channel on YouTube', () => {
    render(<TutorialsPage />)
    const [first] = TUTORIAL_VIDEOS
    fireEvent.click(screen.getAllByRole('button', { name: 'Open on YouTube' })[0])
    expect(openInBrowser).toHaveBeenCalledWith(
      `https://www.youtube.com/watch?v=${first.id}&t=${first.start}s`,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More on the YouTube channel' }))
    expect(openInBrowser).toHaveBeenCalledWith(TUTORIALS_CHANNEL_URL)
  })
})
