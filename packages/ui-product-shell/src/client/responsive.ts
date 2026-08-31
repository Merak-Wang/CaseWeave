export const NARROW_HEADER_IDENTITY_MAX_WIDTH = 340

export function isCompactHeaderWidth(width: number): boolean {
  return width <= 480
}

export function shouldHideHeaderIdentity(width: number): boolean {
  return width <= NARROW_HEADER_IDENTITY_MAX_WIDTH
}
