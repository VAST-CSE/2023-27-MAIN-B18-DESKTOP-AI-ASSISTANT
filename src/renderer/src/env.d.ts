import type { RexApi } from '../../shared/types'

declare global {
  interface Window {
    rex: RexApi
  }
}

export {}
