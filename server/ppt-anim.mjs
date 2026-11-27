import JSZip from 'jszip';

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// 生成 OOXML 页间切换节点 <p:transition>
function buildTransitionXml(transition) {
  switch (transition) {
    case 'fade':
      return '<p:transition spd="med"><p:fade/></p:transition>';
    case 'push':
      return '<p:transition spd="med"><p:push dir="l"/></p:transition>';
    case 'wipe':
      return '<p:transition spd="med"><p:wipe dir="l"/></p:transition>';
    case 'zoom':
      return '<p:transition spd="med"><p:zoom dir="in"/></p:transition>';
    default:
      return '';
  }
}

// 为单个对象构建入场行为节点（兼容 Microsoft PowerPoint 与 WPS 演示）
function buildEffectChildren(spId, anim, nextId) {
  const target = `<p:tgtEl><p:spTgt spid="${spId}"/></p:tgtEl>`;
  const setVis = `<p:set><p:cBhvr><p:cTn id="${nextId()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
  const fade = `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${nextId()}" dur="420" fill="hold"/>${target}</p:cBhvr></p:animEffect>`;

  if (anim === 'wipe') {
    const wipe = `<p:animEffect transition="in" filter="wipe(right)"><p:cBhvr><p:cTn id="${nextId()}" dur="460" fill="hold"/>${target}</p:cBhvr></p:animEffect>`;
    return { presetId: 22, presetSubtype: 8, xml: setVis + wipe };
  }
  if (anim === 'zoom-in') {
    const scale = `<p:animScale><p:cBhvr><p:cTn id="${nextId()}" dur="440" fill="hold"/>${target}</p:cBhvr><p:from x="90000" y="90000"/><p:to x="100000" y="100000"/></p:animScale>`;
    return { presetId: 23, presetSubtype: 16, xml: setVis + fade + scale };
  }
  if (anim === 'fade-up') {
    const moveY = `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${nextId()}" dur="460" fill="hold"/>${target}<p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_y+0.04"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_y"/></p:val></p:tav></p:tavLst></p:anim>`;
    return { presetId: 2, presetSubtype: 4, xml: setVis + fade + moveY };
  }
  if (anim === 'fly-left') {
    const moveX = `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${nextId()}" dur="460" fill="hold"/>${target}<p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_x-0.06"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>`;
    return { presetId: 2, presetSubtype: 8, xml: setVis + fade + moveX };
  }
  if (anim === 'fly-right') {
    const moveX = `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${nextId()}" dur="460" fill="hold"/>${target}<p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_x+0.06"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>`;
    return { presetId: 2, presetSubtype: 2, xml: setVis + fade + moveX };
  }
  return { presetId: 10, presetSubtype: 0, xml: setVis + fade };
}

// 构建符合 PowerPoint 与 WPS 规范的三层 mainSeq 动画树与 <p:bldLst>
function buildTimingXml(items) {
  if (!items.length) return '';

  // 按 order 分组并排序：同 order 同时入场，不同 order 按 160ms 依次阶梯入场
  const byOrder = new Map();
  for (const item of items) {
    const key = `${item.order}:${item.trigger}`;
    if (!byOrder.has(key)) {
      byOrder.set(key, { order: item.order, trigger: item.trigger, entries: [] });
    }
    byOrder.get(key).entries.push(item);
  }
  const groups = [...byOrder.values()].sort((a, b) => a.order - b.order);

  // 将连续 auto 合并为自动触发组（delay="0"），遇到 click 开启新的点击触发组（delay="indefinite"）
  const clickSteps = [];
  for (const group of groups) {
    if (!clickSteps.length || group.trigger === 'click') {
      clickSteps.push({
        isClick: group.trigger === 'click',
        groups: [group]
      });
    } else {
      clickSteps[clickSteps.length - 1].groups.push(group);
    }
  }

  let idSeq = 1;
  const nextId = () => idSeq++;
  const rootId = nextId(); // 1
  const mainSeqId = nextId(); // 2
  const stepsXml = [];
  const bldSpIds = new Set();

  for (const step of clickSteps) {
    const clickGroupParId = nextId();
    // 兼容 PowerPoint 与 WPS：自动入场组监听 mainSeq 的 onBegin 事件随页面进入立即播放，点击组使用 indefinite 等待鼠标点击
    const clickGroupStCond = step.isClick
      ? '<p:cond delay="indefinite"/>'
      : `<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="${mainSeqId}"/></p:cond>`;
    const stepContainerParId = nextId();
    const effectPars = [];

    for (let gIdx = 0; gIdx < step.groups.length; gIdx++) {
      const group = step.groups[gIdx];
      // 首个自动组稍微延迟 80ms，后续阶梯组间隔 160ms，直接写在效果自身的 stCondLst 上
      const startDelayMs = step.isClick
        ? gIdx * 160
        : 80 + gIdx * 160;

      for (let eIdx = 0; eIdx < group.entries.length; eIdx++) {
        const entry = group.entries[eIdx];
        bldSpIds.add(entry.spId);
        const effParId = nextId();
        const nodeType = gIdx === 0 && eIdx === 0
          ? (step.isClick ? 'clickEffect' : 'withEffect')
          : 'withEffect';
        const effect = buildEffectChildren(entry.spId, entry.anim, nextId);
        effectPars.push(
          `<p:par><p:cTn id="${effParId}" presetID="${effect.presetId}" presetClass="entr" presetSubtype="${effect.presetSubtype}" fill="hold" grpId="0" nodeType="${nodeType}">` +
          `<p:stCondLst><p:cond delay="${startDelayMs}"/></p:stCondLst>` +
          `<p:childTnLst>${effect.xml}</p:childTnLst>` +
          `</p:cTn></p:par>`
        );
      }
    }

    stepsXml.push(
      `<p:par><p:cTn id="${clickGroupParId}" fill="hold"><p:stCondLst>${clickGroupStCond}</p:stCondLst><p:childTnLst>` +
      `<p:par><p:cTn id="${stepContainerParId}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effectPars.join('')}</p:childTnLst></p:cTn></p:par>` +
      `</p:childTnLst></p:cTn></p:par>`
    );
  }

  const bldXml = [...bldSpIds]
    .map(spId => `<p:bldP spid="${spId}" grpId="0"/>`)
    .join('');

  return `<p:timing><p:tnLst><p:par><p:cTn id="${rootId}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>` +
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${mainSeqId}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${stepsXml.join('')}</p:childTnLst></p:cTn>` +
    `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
    `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>` +
    `</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>` +
    `<p:bldLst>${bldXml}</p:bldLst></p:timing>`;
}

// 统一重排单页 <p:cNvPr id="..."/> 防止 pptxgenjs 在表格/图片上产生重复 id，并返回 name -> spId 映射
function normalizeSlideShapeIds(slideXml) {
  let seq = 1;
  const nameToId = new Map();
  const updated = slideXml.replace(/<p:cNvPr\b([^>]*?)(\/?)>/g, (full, attrs, selfClose) => {
    const newId = String(seq++);
    const nextAttrs = /\bid="\d+"/.test(attrs)
      ? attrs.replace(/\bid="\d+"/, `id="${newId}"`)
      : ` id="${newId}"${attrs}`;
    const nameMatch = nextAttrs.match(/\bname="([^"]*)"/);
    if (nameMatch && nameMatch[1]) {
      nameToId.set(nameMatch[1], newId);
    }
    return `<p:cNvPr${nextAttrs}${selfClose}>`;
  });
  return { xml: updated, nameToId };
}

// 对 pptxgenjs 生成的 .pptx Buffer 执行 OOXML 后处理，注入原生切换动画与入场动画
export async function applyPptxAnimations(pptxBuffer, slideSpecs) {
  const hasAny = slideSpecs.some(spec => (spec.transition && spec.transition !== 'none') || spec.animations.length > 0);
  if (!hasAny) return pptxBuffer;

  const zip = await JSZip.loadAsync(pptxBuffer);
  for (let i = 0; i < slideSpecs.length; i++) {
    const spec = slideSpecs[i];
    const filePath = `ppt/slides/slide${i + 1}.xml`;
    const file = zip.file(filePath);
    if (!file) continue;

    let xml = await file.async('string');
    const normalized = normalizeSlideShapeIds(xml);
    xml = normalized.xml;

    const transitionXml = buildTransitionXml(spec.transition);
    const resolvedAnims = [];
    for (const anim of spec.animations) {
      const spId = normalized.nameToId.get(escapeXmlAttr(anim.objectName));
      if (!spId) continue;
      resolvedAnims.push({
        spId,
        anim: anim.anim,
        order: anim.order,
        trigger: anim.trigger
      });
    }
    const timingXml = buildTimingXml(resolvedAnims);
    const injected = transitionXml + timingXml;
    if (injected) {
      // 遵循 ECMA-376 CT_Slide 顺序：先移除可能存在的旧节点，再在 </p:sld> 前按 transition -> timing 插入
      xml = xml.replace(/<p:transition\b[\s\S]*?<\/p:transition>/g, '');
      xml = xml.replace(/<p:timing\b[\s\S]*?<\/p:timing>/g, '');
      xml = xml.replace(/<\/p:sld>\s*$/, `${injected}</p:sld>`);
    }
    zip.file(filePath, xml);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
