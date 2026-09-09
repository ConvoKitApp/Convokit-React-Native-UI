import { createContext, useContext, type PropsWithChildren } from 'react'

export interface ConvoKitUiTheme {
  colors: {
    background: string; surface: string; primary: string; text: string; mutedText: string;
    border: string; error: string; incomingBubble: string; outgoingBubble: string;
    outgoingText: string; pending: string
  }
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number }
  radius: { sm: number; md: number; lg: number; avatar: number }
  typography: { body: number; caption: number; title: number }
}

export const lightConvoKitTheme: ConvoKitUiTheme = {
  colors: {
    background: '#F6F8F7', surface: '#FFFFFF', primary: '#148F78', text: '#17211F',
    mutedText: '#697572', border: '#D8DEDC', error: '#BA1A1A', incomingBubble: '#FFFFFF',
    outgoingBubble: '#148F78', outgoingText: '#FFFFFF', pending: '#82908C',
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 6, md: 12, lg: 18, avatar: 21 },
  typography: { body: 15, caption: 11, title: 17 },
}

function mergeTheme(overrides?: Partial<ConvoKitUiTheme>): ConvoKitUiTheme {
  if (!overrides) return lightConvoKitTheme
  return {
    colors: { ...lightConvoKitTheme.colors, ...overrides.colors },
    spacing: { ...lightConvoKitTheme.spacing, ...overrides.spacing },
    radius: { ...lightConvoKitTheme.radius, ...overrides.radius },
    typography: { ...lightConvoKitTheme.typography, ...overrides.typography },
  }
}

const ThemeContext = createContext(lightConvoKitTheme)
export function ConvoKitUiProvider({ theme, children }: PropsWithChildren<{ theme?: Partial<ConvoKitUiTheme> }>) {
  return <ThemeContext.Provider value={mergeTheme(theme)}>{children}</ThemeContext.Provider>
}
export const useConvoKitTheme = (): ConvoKitUiTheme => useContext(ThemeContext)
