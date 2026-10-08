import { describe, expect, it } from 'vitest';
import { appSlug } from '../export/desktop';

describe('appSlug (package name / app id of a desktop build)', () => {
  it('lowercase ASCII with dashes', () => {
    expect(appSlug('Meu Pet')).toBe('meu-pet');
    expect(appSlug('Coração Valente!')).toBe('coracao-valente');
    expect(appSlug('meu-pet')).toBe('meu-pet');
    expect(appSlug('🐶')).toBe('game');
  });
});
