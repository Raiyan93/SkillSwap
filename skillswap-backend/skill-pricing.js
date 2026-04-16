(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SkillSwapPricing = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var FALLBACKS = {
    beginner: 15,
    intermediate: 25,
    expert: 33
  };

  var LEVELS = ['beginner', 'intermediate', 'expert'];

  var PRICE_TABLE = {
    'html': { beginner: 13, intermediate: 20, expert: 30 },
    'css': { beginner: 13, intermediate: 20, expert: 30 },
    'html/css': { beginner: 14, intermediate: 21, expert: 30 },
    'javascript': { beginner: 15, intermediate: 24, expert: 32 },
    'typescript': { beginner: 16, intermediate: 25, expert: 33 },
    'python': { beginner: 16, intermediate: 24, expert: 33 },
    'java': { beginner: 16, intermediate: 25, expert: 34 },
    'c': { beginner: 17, intermediate: 27, expert: 35 },
    'c++': { beginner: 17, intermediate: 27, expert: 35 },
    'c#': { beginner: 16, intermediate: 25, expert: 34 },
    'go': { beginner: 16, intermediate: 26, expert: 34 },
    'rust': { beginner: 18, intermediate: 28, expert: 36 },
    'kotlin': { beginner: 15, intermediate: 24, expert: 33 },
    'swift': { beginner: 15, intermediate: 24, expert: 33 },
    'scala': { beginner: 17, intermediate: 27, expert: 35 },
    'haskell': { beginner: 18, intermediate: 28, expert: 36 },
    'assembly': { beginner: 18, intermediate: 29, expert: 36 },
    'sql': { beginner: 14, intermediate: 22, expert: 31 },
    'excel': { beginner: 11, intermediate: 20, expert: 30 },
    'linux': { beginner: 15, intermediate: 24, expert: 33 },
    'bash': { beginner: 14, intermediate: 22, expert: 31 },
    'react': { beginner: 16, intermediate: 26, expert: 34 },
    'vue': { beginner: 15, intermediate: 24, expert: 33 },
    'angular': { beginner: 16, intermediate: 26, expert: 34 },
    'node': { beginner: 15, intermediate: 24, expert: 33 },
    'next.js': { beginner: 16, intermediate: 26, expert: 34 },
    'django': { beginner: 15, intermediate: 24, expert: 33 },
    'flask': { beginner: 14, intermediate: 22, expert: 31 },
    'fastapi': { beginner: 15, intermediate: 24, expert: 33 },
    'docker': { beginner: 15, intermediate: 24, expert: 33 },
    'kubernetes': { beginner: 18, intermediate: 28, expert: 36 },
    'devops': { beginner: 17, intermediate: 27, expert: 35 },
    'aws': { beginner: 16, intermediate: 26, expert: 35 },
    'gcp': { beginner: 16, intermediate: 26, expert: 35 },
    'azure': { beginner: 16, intermediate: 26, expert: 35 },
    'cloud': { beginner: 15, intermediate: 25, expert: 34 },
    'machine learning': { beginner: 18, intermediate: 29, expert: 36 },
    'deep learning': { beginner: 18, intermediate: 29, expert: 36 },
    'data science': { beginner: 17, intermediate: 28, expert: 35 },
    'nlp': { beginner: 18, intermediate: 29, expert: 36 },
    'computer vision': { beginner: 18, intermediate: 29, expert: 36 },
    'pytorch': { beginner: 17, intermediate: 28, expert: 35 },
    'tensorflow': { beginner: 17, intermediate: 28, expert: 35 },
    'llm': { beginner: 18, intermediate: 29, expert: 36 },
    'ai': { beginner: 17, intermediate: 28, expert: 35 },
    'statistics': { beginner: 15, intermediate: 24, expert: 33 },
    'matlab': { beginner: 15, intermediate: 24, expert: 33 },
    'figma': { beginner: 13, intermediate: 22, expert: 31 },
    'ui/ux': { beginner: 14, intermediate: 23, expert: 32 },
    'graphic design': { beginner: 13, intermediate: 22, expert: 31 },
    'photoshop': { beginner: 13, intermediate: 21, expert: 31 },
    'illustrator': { beginner: 14, intermediate: 22, expert: 31 },
    'after effects': { beginner: 15, intermediate: 24, expert: 33 },
    'blender': { beginner: 16, intermediate: 26, expert: 35 },
    '3d modeling': { beginner: 16, intermediate: 26, expert: 35 },
    'video editing': { beginner: 14, intermediate: 23, expert: 32 },
    'premiere pro': { beginner: 14, intermediate: 23, expert: 32 },
    'english': { beginner: 10, intermediate: 20, expert: 30 },
    'hindi': { beginner: 10, intermediate: 20, expert: 30 },
    'spanish': { beginner: 13, intermediate: 22, expert: 31 },
    'french': { beginner: 14, intermediate: 23, expert: 32 },
    'german': { beginner: 14, intermediate: 23, expert: 33 },
    'japanese': { beginner: 16, intermediate: 26, expert: 35 },
    'arabic': { beginner: 16, intermediate: 25, expert: 34 },
    'mandarin': { beginner: 17, intermediate: 27, expert: 36 },
    'chinese': { beginner: 17, intermediate: 27, expert: 36 },
    'korean': { beginner: 16, intermediate: 26, expert: 35 },
    'russian': { beginner: 16, intermediate: 26, expert: 35 },
    'piano': { beginner: 14, intermediate: 23, expert: 32 },
    'guitar': { beginner: 13, intermediate: 22, expert: 31 },
    'violin': { beginner: 16, intermediate: 26, expert: 35 },
    'drums': { beginner: 14, intermediate: 23, expert: 32 },
    'singing': { beginner: 13, intermediate: 22, expert: 31 },
    'drawing': { beginner: 12, intermediate: 21, expert: 30 },
    'painting': { beginner: 12, intermediate: 21, expert: 30 },
    'math': { beginner: 14, intermediate: 23, expert: 32 },
    'calculus': { beginner: 15, intermediate: 24, expert: 33 },
    'physics': { beginner: 15, intermediate: 24, expert: 33 },
    'chemistry': { beginner: 15, intermediate: 24, expert: 33 },
    'biology': { beginner: 13, intermediate: 22, expert: 31 },
    'public speaking': { beginner: 12, intermediate: 21, expert: 30 },
    'writing': { beginner: 11, intermediate: 20, expert: 30 },
    'yoga': { beginner: 10, intermediate: 20, expert: 30 },
    'cooking': { beginner: 10, intermediate: 20, expert: 30 }
  };

  var ALIASES = {
    'js': 'javascript',
    'ts': 'typescript',
    'nodejs': 'node',
    'golang': 'go',
    'cpp': 'c++',
    'nextjs': 'next.js',
    'ml': 'machine learning',
    'deep learning': 'deep learning',
    'neural networks': 'deep learning',
    'nlp': 'nlp',
    'computer vision': 'computer vision',
    'ui ux': 'ui/ux',
    'ux ui': 'ui/ux',
    'user experience': 'ui/ux',
    'user interface': 'ui/ux',
    '3d': '3d modeling',
    '3d design': '3d modeling'
  };

  function normalizeLevel(level) {
    var normalized = String(level || '').trim().toLowerCase();
    if (normalized === 'some exposure') return 'intermediate';
    if (LEVELS.indexOf(normalized) !== -1) return normalized;
    return 'intermediate';
  }

  function normalizeSkill(skill) {
    return String(skill || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9+#./ ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveSkillKey(skill) {
    var normalized = normalizeSkill(skill);
    if (!normalized) return '';
    if (PRICE_TABLE[normalized]) return normalized;
    if (ALIASES[normalized]) return ALIASES[normalized];
    var keys = Object.keys(PRICE_TABLE);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (normalized.indexOf(key) !== -1 || key.indexOf(normalized) !== -1) return key;
    }
    var aliasKeys = Object.keys(ALIASES);
    for (var j = 0; j < aliasKeys.length; j += 1) {
      var alias = aliasKeys[j];
      if (normalized.indexOf(alias) !== -1 || alias.indexOf(normalized) !== -1) return ALIASES[alias];
    }
    return normalized;
  }

  function clampCredits(level, value) {
    var normalizedLevel = normalizeLevel(level);
    var numeric = Number(value || 0);
    if (!numeric) return FALLBACKS[normalizedLevel];
    if (normalizedLevel === 'beginner') return Math.max(10, Math.min(20, Math.round(numeric)));
    if (normalizedLevel === 'expert') return Math.max(30, Math.min(36, Math.round(numeric)));
    return Math.max(20, Math.min(30, Math.round(numeric)));
  }

  function getFallbackCredits(level) {
    return FALLBACKS[normalizeLevel(level)];
  }

  function getSkillPricing(skill) {
    var key = resolveSkillKey(skill);
    return PRICE_TABLE[key] || null;
  }

  function getCredits(skill, level) {
    var normalizedLevel = normalizeLevel(level);
    var pricing = getSkillPricing(skill);
    if (!pricing) return getFallbackCredits(normalizedLevel);
    return clampCredits(normalizedLevel, pricing[normalizedLevel]);
  }

  function getDifficultyBadge(skill) {
    var pricing = getSkillPricing(skill);
    var reference = pricing ? pricing.expert : getFallbackCredits('expert');
    if (reference >= 35) return { label: 'Expert-tier', color: '#f97316' };
    if (reference >= 33) return { label: 'Advanced', color: '#a78bfa' };
    if (reference >= 31) return { label: 'Intermediate', color: '#60a5fa' };
    return { label: 'Foundational', color: '#34d399' };
  }

  return {
    FALLBACKS: FALLBACKS,
    LEVELS: LEVELS,
    PRICE_TABLE: PRICE_TABLE,
    ALIASES: ALIASES,
    normalizeLevel: normalizeLevel,
    normalizeSkill: normalizeSkill,
    resolveSkillKey: resolveSkillKey,
    clampCredits: clampCredits,
    getFallbackCredits: getFallbackCredits,
    getSkillPricing: getSkillPricing,
    getCredits: getCredits,
    getDifficultyBadge: getDifficultyBadge
  };
});
