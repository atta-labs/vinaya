import { describe, expect, it, vi } from 'vitest'
import { ensureLabelExists, LABEL_COLOR } from './ensure-label'

describe('ensureLabelExists', () => {
  it('creates the label when it does not exist', () => {
    const listLabelNames = vi.fn().mockReturnValue(['other-label'])
    const createLabel = vi.fn()

    ensureLabelExists('owner/repo', 'vinaya/direct-main-push', 'some description', {
      listLabelNames,
      createLabel
    })

    expect(listLabelNames).toHaveBeenCalledWith('owner/repo')
    expect(createLabel).toHaveBeenCalledWith('owner/repo', 'vinaya/direct-main-push', 'some description', LABEL_COLOR)
  })

  it('is a no-op when the label already exists', () => {
    const listLabelNames = vi.fn().mockReturnValue(['vinaya/direct-main-push', 'other-label'])
    const createLabel = vi.fn()

    ensureLabelExists('owner/repo', 'vinaya/direct-main-push', 'some description', {
      listLabelNames,
      createLabel
    })

    expect(createLabel).not.toHaveBeenCalled()
  })
})
