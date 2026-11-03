// Code-native line art from the reviewed V3 study. Inputs are numeric geometry only;
// diary titles and content never enter SVG markup. Dates use a stable seed.
const f = value => Number(value.toFixed(2));
  const random = seed => { let value = seed >>> 0; return () => { value = (Math.imul(1664525,value) + 1013904223) >>> 0; return value / 4294967296; }; };
  function leaf(x,y,angle,size,width = .5) {
    const w = size * width;
    return `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(angle)})"><path class="tree-leaf" d="M0 0Q${f(w)} ${f(-size * .38)} 0 ${f(-size)}Q${f(-w)} ${f(-size * .36)} 0 0Z"/><path class="tree-leaf-vein" d="M0 0Q1 ${f(-size * .35)} 0 ${f(-size * .77)}"/></g>`;
  }
  function canopy(seed,h,w,tilt,form) {
    const rng = random(seed + 941),points = [],cy = -h * (form === 'round' ? .72 : .74);
    for (let i=0;i<18;i++) {
      const angle = i / 18 * Math.PI * 2,variation = i % 2 ? 1.04 + rng() * .1 : .87 + rng() * .11;
      points.push({x:tilt + Math.cos(angle) * (w + 5) * variation,y:cy + Math.sin(angle) * (h * .29 + 3) * variation});
    }
    const midpoint = (a,b) => `${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2)}`;
    let d = `M${midpoint(points.at(-1),points[0])}`;
    points.forEach((point,i) => { d += `Q${f(point.x)} ${f(point.y)} ${midpoint(point,points[(i + 1) % points.length])}`; });
    return `<path class="tree-canopy" d="${d}Z"/>`;
  }
  function foliage(season,branches,entry,h,w,tilt,form) {
    if (season === 'neutral') return '';
    const rng = random(entry.seed * 51 + 11),snowiness = .38 + rng() * .48;
    let result = season === 'summer' ? canopy(entry.seed,h,w,tilt,form) : '';
    branches.forEach((b,i) => {
      const size = 4.8 + entry.height * 1.35 + rng() * 1.8;
      if (season === 'spring') {
        if (i % 2 === 0 || i > branches.length - 3) result += leaf(b.x,b.y,b.side * (32 + rng() * 28),size * .78);
        if (rng() > .48) result += leaf(b.x - b.side * 1.5,b.y + 2,-b.side * 35,size * .6);
        if (entry.seed % 5 === 0 && i === branches.length - 1) result += `<circle class="tree-blossom" cx="${f(b.x)}" cy="${f(b.y - 2)}" r="1.8"/>`;
      } else if (season === 'summer') {
        result += leaf(b.x,b.y,b.side * (45 + rng() * 18),size,.56);
        result += leaf(b.x - b.side * 1.4,b.y + 1.3,-b.side * 30,size * .85,.55);
        if (entry.height > 0) result += leaf(b.x * .72,b.y + 2,-b.side * 20,size * .74,.6);
        if (entry.height === 2 && rng() > .35) result += leaf(b.x * .88,b.y - 2,5,size * .7,.62);
      } else if (season === 'autumn') {
        if (rng() > .28) result += leaf(b.x,b.y,b.side * (65 + rng() * 23),size * .92,.56);
        if (rng() > .44 || entry.height === 0) {
          const radius = 2 + entry.height * .35 + rng() * .6;
          result += `<path class="tree-branch" d="M${f(b.x)} ${f(b.y)}v3.5"/><circle class="tree-fruit" cx="${f(b.x)}" cy="${f(b.y + 3.5 + radius)}" r="${f(radius)}"/>`;
          if (entry.height === 2 && i === 3) result += `<circle class="tree-fruit" cx="${f(b.x + 4)}" cy="${f(b.y + 7)}" r="${f(radius * .8)}"/>`;
        }
      } else if (rng() < snowiness) {
        const from = .3 + rng() * .18,to = .74 + rng() * .24;
        const d = `M${f(b.x * from)} ${f(b.startY + (b.y - b.startY) * from - 1.2)}Q${f(b.x * .66)} ${f(b.y - .6)} ${f(b.x * to)} ${f(b.y - 1.1)}`;
        result += `<g class="branch-snow" style="--snow-weight:${f(2 + rng() * 1.7)}px"><path class="snow-under" d="${d}"/><path class="snow-top" d="${d}"/></g>`;
      }
    });
    if (season === 'spring' || season === 'summer') {
      result += leaf(tilt,-h,-18,season === 'spring' ? 5.2 : 7.6);
      result += leaf(tilt,-h + 3,42,season === 'spring' ? 4.4 : 6.8);
    }
    if (season === 'winter') {
      const spread = 4 + rng() * 7;
      result += `<path class="snow-under" d="M${f(-spread)} -1Q0 -4 ${f(spread + 2)} -1"/><path class="snow-top" d="M${f(-spread)} -1Q0 -4 ${f(spread + 2)} -1"/>`;
      for (let i=0;i<2 + Math.floor(rng() * 3);i++) result += `<circle class="snow-dot" cx="${f((rng() - .5) * (w * 3))}" cy="${f(-h * (.3 + rng() * .74))}" r="${f(.7 + rng() * .6)}"/>`;
    }
    return result;
  }
  function tree(entry,geo) {
    const rng = random(entry.seed),forms = ['upright','round','slender','leaning','upright'];
    const form = forms[entry.seed % forms.length],h = geo.h;
    const w = geo.w * ({upright:1,round:1.12,slender:.8,leaning:.97}[form]);
    const tilt = geo.tilt + (form === 'leaning' ? (entry.seed % 2 ? 3 : -3) : 0);
    const count = [3,5,8][entry.height] + (entry.height > 0 && rng() > .66 ? 1 : 0),branches = [];
    let wood = `<path class="tree-trunk" d="M0 0C${f(-tilt * .35)} ${f(-h * .3)} ${f(tilt * .5)} ${f(-h * .7)} ${f(tilt)} ${f(-h)}"/>`;
    for (let i=0;i<count;i++) {
      const side = i % 2 === 0 ? -1 : 1,fraction = .42 + i / count * .47;
      const sy = -h * fraction,branchWidth = w * (.68 + rng() * .32) * (1 - (fraction - .4) * .45);
      const bx = side * branchWidth + tilt * fraction,by = sy - h * (.11 + rng() * .07);
      branches.push({x:bx,y:by,side,startY:sy});
      wood += `<path class="tree-branch" d="M${f(tilt * fraction * .5)} ${f(sy)}Q${f(bx * .58)} ${f(sy - h * .035)} ${f(bx)} ${f(by)}"/>`;
      if (entry.height === 2 && i % 3 === 0) wood += `<path class="tree-branch" d="M${f(bx * .65)} ${f(sy + (by - sy) * .57)}q${f(-side * 2)} -5 ${f(side * 1.5)} -9"/>`;
    }
    const {from,to,mix} = geo.season,first = foliage(from,branches,entry,h,w,tilt,form);
    const dress = from === to ? first : `<g opacity="${f(1 - mix)}">${first}</g><g opacity="${f(mix)}">${foliage(to,branches,entry,h,w,tilt,form)}</g>`;
    return `<g data-tree-form="${form}" data-tree-family="v1">${wood}${dress}</g>`;
  }
const n = value => Number(value.toFixed(2));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const noise = seed => { const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
  const path = (d, cls, extra = '') => `<path${cls ? ` class="${cls}"` : ''} d="${d}" ${extra}/>`;
  const circle = (x, y, r, extra = '') => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" ${extra}/>`;
  const line = (d, extra = '') => path(d, '', extra);
  const dot = (x, y, r = .7, color = 'currentColor') => circle(x, y, r, `fill="${color}" stroke="none"`);
  function flower(x, y, radius = 2) {
    let petals = '';
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5 - Math.PI / 2;
      petals += circle(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, radius * .56, 'fill="var(--flower)" fill-opacity=".2" stroke="var(--flower)" stroke-width=".5"');
    }
    return petals + dot(x, y, .6);
  }
  const grass = (x = 0, y = 0) => `<g transform="translate(${x} ${y})" opacity=".65">${line('M-5 0Q-5-5-8-7M-3 0Q-1-8-3-11M0 0Q3-6 6-7')}</g>`;
  const bird = (x, y, flip = 1) => `<g transform="translate(${x} ${y}) scale(${flip} 1)">${line('M-7-3Q-8-9-3-10Q0-15 4-12Q7-11 6-7L10-6L6-5Q4 1-2-1L-10-5Z', 'fill="currentColor" fill-opacity=".045"')}${line('M-4-6Q-1-3 2-6M-2-1v3M2-1l1 3')}${dot(3.7,-10,.6)}</g>`;
  const butterfly = (x, y) => `<g transform="translate(${x} ${y}) rotate(-15)">${line('M0 1Q-9-3-7-8Q-3-11 0-3Q5-12 8-7Q9-2 0 1Q6 0 4 4Q1 6 0 1Q-5 6-6 2Q-6 0 0 1', 'fill="currentColor" fill-opacity=".035"')}${line('M0 3V-4M0-4l-2-2M0-4l2-2')}</g>`;
  const dragonfly = (x, y) => `<g transform="translate(${x} ${y}) rotate(12)">${line('M0-3v11M0 0Q-10-7-12-2Q-11 1 0 0Q9-7 12-3Q12 1 0 0M0 1Q-9-1-9 3Q-7 5 0 1Q8-1 9 3Q8 5 0 1')}${dot(0,-4,1)}</g>`;
  const snowCap = d => line(d, 'stroke="var(--snow-edge)" stroke-width="2.4" opacity=".65"') + line(d, 'stroke="var(--snow)" stroke-width="1.5"');
  const fallenLeaf = (x, y, angle = 0) => `<g transform="translate(${x} ${y}) rotate(${angle})">${line('M-6 0Q-3-5 5-1Q3 4-6 0ZM-8 1L3-1', 'fill="currentColor" fill-opacity=".08"')}</g>`;
  function spring(variant) {
    if (variant === 0) return grass(-20) + grass(17) + line('M-8 0Q-9-9-6-16M4 0Q2-5 5-10M-8-5q-6 0-6-4q5-1 6 4M4-3q5 0 6-4') + flower(-6,-17) + flower(5,-11,1.6);
    if (variant === 1) return grass(-13) + line('M8 0Q5-8 9-14M7-5q-5 0-5-4') + flower(9,-15,1.8) + butterfly(-8,-25) + line('M-20-18q-3 2-2 4', 'opacity=".35" stroke-dasharray="1 3"');
    if (variant === 2) return grass(-17) + bird(6,-3) + line('M4-1h10M-3-3q-4-4-7-3', 'opacity=".6"') + flower(-12,-8,1.4);
    return line('M-20 0Q-7-9 6-24M-7-8Q-12-15-11-19M0-16q8 1 14-5M4-22q-2-6 1-10') + flower(-11,-20,1.7) + flower(6,-25,2) + flower(15,-22,1.6) + fallenLeaf(18,-6,40) + grass(-22);
  }
  function summer(variant) {
    if (variant === 0) return line('M-24-1q8 2 16 0M-3-1q13 2 26-1M-7-3v-11M6-3q3-6 2-10') + line('M-18-7Q-16-15-6-12Q2-10-3-6Q-11-5-18-7ZM-6-12l-3 4', 'fill="currentColor" fill-opacity=".07"') + line('M7-13Q-2-14 0-20Q5-20 7-16Q6-23 10-25Q14-20 11-16Q17-21 19-18Q17-12 7-13Z', 'stroke="var(--flower)" fill="var(--flower)" fill-opacity=".08"') + dragonfly(-12,-28);
    if (variant === 1) return line('M-24-1q8 2 15 0M-3 0q12 1 26-2M-19-8L18-8L10-1H-10ZM-10-8L0-23L9-8M0-23V-8M-19-8L0-4L18-8', 'fill="currentColor" fill-opacity=".025"') + line('M-24-16q2-3 4 0q3-4 6-1', 'opacity=".5"');
    if (variant === 2) return grass(-15) + grass(18) + line('M2 0V-25M2-25L-8-34L-9-25ZM2-25L11-35L11-26ZM2-25L12-17L3-16ZM2-25L-6-15L-7-24Z', 'fill="currentColor" fill-opacity=".045"') + circle(2,-25,1.5,'fill="var(--paper)"');
    return grass(-17) + line('M15 0q-2-13 2-19M17-11q7-4 6-9M13-1q-5-6-5-12M-25-1q7 2 14 0M-2-1h9') + dragonfly(-6,-28) + circle(17,-20,1.6,'fill="currentColor" fill-opacity=".12"');
  }
  function autumn(variant) {
    if (variant === 0) return line('M-11-1L-12-13L-6-13L-7-1ZM-21-13Q-19-27-9-26Q2-24 3-14Q-8-10-21-13Z', 'fill="currentColor" fill-opacity=".055"') + line('M10-1l-1-8h4l1 8M4-9Q5-17 11-18Q18-17 20-10Q13-7 4-9Z', 'fill="currentColor" fill-opacity=".045"') + dot(-13,-20,.8) + dot(-6,-18,.6) + grass(-23) + fallenLeaf(21,-2,12);
    if (variant === 1) return fallenLeaf(-15,-3,-20) + fallenLeaf(3,-6,20) + fallenLeaf(17,-2,-12) + fallenLeaf(4,-25,65) + line('M10-18q-8 2-6 7', 'opacity=".35" stroke-dasharray="1 3"') + grass(-24);
    if (variant === 2) return line('M-13-12L-9-1H9L13-12ZM-11-12Q-11-27 0-27Q10-27 11-12M-7-10l2 8M0-10v8M7-10L5-2M-11-7h22', 'fill="currentColor" fill-opacity=".045"') + circle(-5,-15,3,'class="tree-fruit"') + circle(2,-16,3.2,'class="tree-fruit"') + circle(7,-13,2.5,'class="tree-fruit"') + line('M2-19l2-3M-5-18l-1-2') + fallenLeaf(21,-2,23);
    return line('M-11-10Q-10-1-5-1Q1-4 0-13M-13-10Q-13-17-8-18Q-1-19 2-13Q-5-9-13-10ZM-8-18q-1-5 2-7', 'fill="currentColor" fill-opacity=".06"') + fallenLeaf(14,-6,-26) + line('M-11-13l3-2M-6-13l2-3') + grass(-23);
  }
  function winter(variant) {
    if (variant === 0) return circle(0,-9,8.5,'fill="var(--snow)" fill-opacity=".28"') + circle(0,-22,5.7,'fill="var(--snow)" fill-opacity=".3"') + line('M-7-27h14M-4-28v-6h8v6M-8-11L-18-17M-15-15l-1-5M8-11l11-6M16-15l2-5') + line('M-5-17Q0-15 5-18M3-16l2 7', 'stroke="var(--fruit)" stroke-width="1.5"') + dot(-2,-23,.6) + dot(2,-23,.6) + dot(0,-10,.65) + dot(0,-6,.65) + line('M0-21l4 1-4 1', 'stroke="var(--fruit)"') + snowCap('M-17 0q17 2 34 0');
    if (variant === 1) return line('M0 0Q-2-13 0-30M-1-10Q-12-14-16-23M-10-17l-1-10M0-16Q10-20 16-29M10-23l1-10M0-23l-6-7') + snowCap('M-13-20l5 5M3-20l6-3M-2-27l-3-3') + dot(-20,-30,.75,'var(--snow-edge)') + dot(22,-17,.7,'var(--snow-edge)') + snowCap('M-12 0h24');
    if (variant === 2) return line('M-21 0Q-21-8-13-8Q-10-15 0-13Q8-13 12-6Q20-7 22 0', 'fill="currentColor" fill-opacity=".035"') + snowCap('M-18-5q5-3 9-1M5-10q3 0 6 4') + bird(-2,-14,-1) + dot(20,-30,.7,'var(--snow-edge)') + dot(-22,-20,.65,'var(--snow-edge)');
    return line('M-15-1Q-21-6-15-10Q-14-19-5-19Q1-27 6-23L4-31Q5-38 8-31L9-24L12-32Q15-36 15-31L13-21Q20-17 16-11Q9-7 8-1ZM-12-5q6-3 12 0', 'fill="var(--snow)" fill-opacity=".18"') + dot(13,-18,.65) + line('M17-15l3 1M-6-8q4-1 5 3') + snowCap('M-22 0h44') + dot(-25,-2,.8,'var(--snow-edge)');
  }
  const painters = {spring,summer,autumn,winter};
  const sceneNames = {spring:['flowers','butterfly','bird','blossom'],summer:['lotus','paperboat','windmill','dragonfly'],autumn:['mushrooms','fallen-leaves','fruit-basket','acorn'],winter:['snowman','snow-shrub','bird','rabbit']};
  function scene(options) {
    const season = painters[options.season] ? options.season : 'spring';
    const variant = ((Math.floor(Number(options.variant) || 0) % 4) + 4) % 4;
    const x = Number(options.x) || 0, ground = Number(options.ground) || 0;
    const scale = clamp(Number(options.scale) || 1, .1, 1);
    return `<g data-scene="${sceneNames[season][variant]}" aria-hidden="true" pointer-events="none" transform="translate(${n(x)} ${n(ground)}) scale(${n(scale)})" fill="none" stroke="currentColor" stroke-width=".75" stroke-linecap="round" stroke-linejoin="round">${painters[season](variant)}</g>`;
  }
  function ground(options) {
    const {x,y,width,season,seed} = options;
    const count = Math.max(2,Math.min(30,Math.round(width / 35)));
    let result = '';
    for (let i=0;i<count;i++) {
      const r = noise(seed + i * 13),px = (i + .2 + r * .6) / count * width,py = 4 + noise(seed + i * 29) * 16;
      let detail = '';
      if (season === 'spring') {
        detail = grass(0,0) + (i % 3 === 0 ? line('M4 0Q3-4 6-8') + flower(6,-9,1.3) : line('M3 2q5 1 9-1', 'opacity=".3"'));
        if (r > .55) detail += `<ellipse cx="13" cy="2" rx="1.6" ry=".8" fill="var(--flower)" stroke="none" transform="rotate(-25 13 2)"/>`;
      } else if (season === 'summer') {
        detail = grass(0,0) + (i % 3 === 0 ? line('M-12 5q10 3 25 0M-5 8q6 1 13 0', 'opacity=".55"') : line('M7 2q-1-4 3-4q5 1 4 4Z', 'fill="currentColor" fill-opacity=".06"'));
        if (r > .6) detail += line('M-8 1q-3-7 0-12M-8-9l-3-3M-8-6l3-3');
      } else if (season === 'autumn') {
        detail = fallenLeaf(0,0,-30 + r * 70) + fallenLeaf(10,3,15 - r * 50);
        if (i % 3 === 0) detail += line('M-9 1q-5-3-3-6q4-2 5 2l-2 4ZM-13-4l5 1', 'fill="currentColor" fill-opacity=".12"');
        if (r > .5) detail += grass(20,1);
      } else {
        const drift = 10 + r * 14;
        detail = line(`M${n(-drift)} 1Q${n(-drift * .6)} ${n(-4-r*4)} -3-3Q3-8 ${n(drift*.7)}-3Q${n(drift)}-1 ${n(drift)} 1Z`, 'class="snow-drift"');
        detail += snowCap(`M${n(-drift*.6)}-1q${n(drift*.4)}-3 ${n(drift*.9)}-1`);
        detail += dot(-7,-16-r*22,.7+r*.5,'var(--snow-edge)') + dot(13,-8-r*10,.65,'var(--snow-edge)');
        if (i % 4 === 0) detail += line('M-3 5l2 1M3 7l2 1M9 9l2 1', 'opacity=".35"');
      }
      result += `<g class="ground-detail" transform="translate(${n(px)} ${n(py)})" opacity="${n(.58 + r * .32)}">${detail}</g>`;
    }
    return `<g class="ground-texture" data-season="${season}" transform="translate(${n(x)} ${n(y)})" stroke="currentColor" stroke-width=".65" fill="none" color="var(--${season})" aria-hidden="true" pointer-events="none">${result}</g>`;
  }
export { tree as renderSeasonTree, scene as renderSeasonScene, ground as renderSeasonGround };
