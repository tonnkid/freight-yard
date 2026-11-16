// The look plan, in one place: a cold industrial palette for a dusk-lit freight yard.
// Six named values plus two accent hues; the lighting makes every shade the game needs, so no
// other colour appears in the code. The same names are the CSS custom properties in index.html.
export const PALETTE = {
  // The first build sat at #0b0f14 / #161d26 / #232e3a — around 15-44 of 255 luminance. Every capture
  // came back reading as "near-total darkness", and no amount of exposure recovered detail because
  // the materials themselves had almost no light to return. These keep the cold dusk-yard hue but
  // lift the values into a range a screenshot can actually show.
  canvas: '#141b24',
  surface: '#26313f',
  hairline: '#3a4757',
  ink: '#e8eef5',
  muted: '#9aabbe',
  accent: '#ff8a3d',
  // Two sides of the yard: the defending crew wears cold blue, the attackers warm rust.
  teamDef: '#5fb0e8',
  teamAtk: '#e8734a',
  // Objective and hazard marks.
  objective: '#f2c14e',
};

export function shade(name) {
  return PALETTE[name];
}
