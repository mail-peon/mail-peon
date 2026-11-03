export { hasNoCursor, normalizeAccount, normalizeCursor } from './normalize/account'
/** Public facade for the domain modules. Import implementation dependencies directly. */
export { mergeDefaults } from './normalize/common'
export { MAX_BODY_CHARS, normalizeAddresses, normalizeMail } from './normalize/mail'
export { normalizeExpiry, normalizeLinks, normalizeMailTypeMatch, normalizeMailTypeMatches, normalizeMailTypeRecord } from './normalize/mail-type'
export { normalizeBlockedList, normalizeMatchers, parseBlockedListText } from './normalize/matching'
export { isReservedRuleId, normalizeRule } from './normalize/rule'
export { clampCheckInterval, normalizeAiSettings, normalizeAppSettings, normalizeRetention } from './normalize/settings'
