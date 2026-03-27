const STORAGE_KEY = 'kubera-warhunt-v5pro-final-locked';
const defaultSettings = {
  bankroll: 30000,
  targetDollar: 500,
  targetPercent: 1.67,
  stopLoss: 50000,
  min: 100,
  max: 3000,
  coin: 100,
  targetNum: 500,
  doubleLadder: 'on',
  keypadMode: 'combined',
  maxSteps: 30,
  reserve: 20000,
  capRule: 'on',
  stopLossPerNumber: -100,
  attackMode: 'classic'
};
const titles = { sangram:'⚔ SANGRAM', vyuha:'🛡 VYUHA', granth:'📜 GRANTH', drishti:'👁 DRISHTI', sopana:'🪜 SOPANA', yantra:'⚙ YANTRA', medha:'🧠 MEDHA' };
let deferredPrompt = null;
let historyStack = [];
let redoStack = [];
let pending = { Y: null, K: null };
let keypadBusy = false;

const q = id => document.getElementById(id);
let modalResolver = null;
let modalConfig = { title:'', text:'', okLabel:'OK', cancelLabel:'Cancel', okClass:'warn' };
const fmtMoney = n => '₹ ' + Number(n || 0).toLocaleString('en-IN');
const clone = obj => JSON.parse(JSON.stringify(obj));
const parseSignedInt = (value, fallback=0) => { const cleaned = String(value ?? '').replace(/[^0-9-]/g,'').replace(/(?!^)-/g,''); const n = Number(cleaned); return Number.isFinite(n) ? n : fallback; };

function getAttackMode(){ return state?.settings?.attackMode || 'classic'; }
function attackThresholdForMode(mode){ return mode==='thirdstrike' ? 2 : mode==='fourthstrike' ? 3 : 1; }
function waitingCodeForInfo(info){
  const mode = getAttackMode();
  if(mode==='thirdstrike') return 'W2';
  if(mode==='fourthstrike') return 'W3';
  return 'W';
}
function activateTrackedNumber(info){
  info.status='A';
  info.step=1;
  info.ladder=1;
  info.activeAt=state.currentChakra;
  info.prevLoss=0;
}

function freshNumber(){ return { status:'I', step:0, ladder:1, activeAt:null, prevLoss:0, winningBet:0, lastNet:0, pendingSecond:false, watchCount:0 }; }

function askModal({ title, text, okLabel='OK', cancelLabel='Cancel', okClass='warn' }){
  return new Promise(resolve=>{
    modalResolver = resolve;
    modalConfig = { title, text, okLabel, cancelLabel, okClass };
    q('confirmTitle').textContent = title;
    q('confirmText').textContent = text;
    q('confirmCancelBtn').textContent = cancelLabel;
    q('confirmOkBtn').textContent = okLabel;
    q('confirmOkBtn').classList.toggle('warn', okClass === 'warn');
    q('confirmOverlay').classList.remove('hidden');
    q('confirmOverlay').setAttribute('aria-hidden','false');
    q('confirmOkBtn').focus();
  });
}
function askClearKumbh(){
  return askModal({ title:'KUMBHA CLEAR', text:'Clear current Kumbh?', okLabel:'OK', cancelLabel:'Cancel', okClass:'warn' });
}
function askApplyYantra(){
  return askModal({ title:'APPLY YANTRA', text:'Apply current Yantra settings?', okLabel:'Yes', cancelLabel:'No', okClass:'' });
}
function closeClearKumbh(answer){
  q('confirmOverlay').classList.add('hidden');
  q('confirmOverlay').setAttribute('aria-hidden','true');
  if(modalResolver){
    const resolve = modalResolver;
    modalResolver = null;
    resolve(answer);
  }
}
function createSide(){ const s={}; for(let i=1;i<=9;i++) s[i]=freshNumber(); return s; }
function roundUpToCoin(value, coin){ return Math.max(coin, Math.ceil(value / coin) * coin); }

function buildLadder(settings){
  const rows = [];
  let previousLoss = 0;
  let bet = roundUpToCoin(settings.min, settings.coin);
  let currentLevel = bet;
  for(let step=1; step<=settings.maxSteps; step++){
    bet = Math.min(settings.max, roundUpToCoin(bet, settings.coin));
    const winReturn = bet * 9;
    rows.push({
      step: `S${step}`,
      bet,
      winReturn,
      netProfit: winReturn - (previousLoss + bet),
      ifLoseTotal: -(previousLoss + bet)
    });
    previousLoss += bet;
    if(step < settings.maxSteps){
      const hits = ((bet * 8) - previousLoss) >= settings.targetNum;
      if(!hits){
        if(settings.doubleLadder === 'on'){
          currentLevel = Math.min(settings.max, roundUpToCoin(currentLevel * 2, settings.coin));
          bet = currentLevel;
        } else {
          let probe = bet;
          while((((probe * 8) - previousLoss) < settings.targetNum) && probe < settings.max){
            probe = Math.min(settings.max, roundUpToCoin(probe + settings.coin, settings.coin));
          }
          bet = probe;
          currentLevel = bet;
        }
      } else {
        bet = currentLevel;
      }
    }
  }
  return rows;
}

function freshState(){
  const settings = { ...defaultSettings };
  return {
    settings,
    liveBankroll: settings.bankroll,
    currentChakra: 0,
    numbers: { Y: createSide(), K: createSide() },
    drishti: [],
    granth: [],
    currentKumbhId: null,
    summary: { totalAhuti: 0, maxExposure: 0 },
    ladder: buildLadder(settings),
    activeTab: 'sangram'
  };
}
function reviveState(raw){ const base = freshState(); const settings={...base.settings,...(raw.settings||{})}; if(!Number.isFinite(Number(settings.stopLoss)) || Number(settings.stopLoss)<=0) settings.stopLoss = base.settings.stopLoss; if(!Number.isFinite(Number(settings.stopLossPerNumber))) settings.stopLossPerNumber = base.settings.stopLossPerNumber; if(!settings.doubleLadder) settings.doubleLadder = 'on'; return {...base,...raw,settings,numbers:raw.numbers||base.numbers,summary:{...base.summary,...(raw.summary||{})},ladder:Array.isArray(raw.ladder)&&raw.ladder.length?raw.ladder:buildLadder(settings),activeTab:raw.activeTab||'sangram'}; }
function coreSnapshot(){ return { state: clone(state), pending: clone(pending) }; }
function historySnapshot(){ return JSON.stringify(coreSnapshot()); }
function persistedSnapshot(){ return JSON.stringify(coreSnapshot()); }
function restoreSnapshot(payload){ const snap = typeof payload==='string' ? JSON.parse(payload) : payload; state = reviveState(snap.state || snap); pending = snap.pending || {Y:null,K:null}; if(!Array.isArray(historyStack)) historyStack = []; if(!Array.isArray(redoStack)) redoStack = []; }
function loadState(){ try{ const raw = localStorage.getItem(STORAGE_KEY); if(!raw) return freshState(); const parsed = JSON.parse(raw); restoreSnapshot(parsed); historyStack = []; redoStack = []; return state; }catch{ historyStack = []; redoStack = []; return freshState(); } }
let state = freshState();
loadState();
function saveState(){ try{ localStorage.setItem(STORAGE_KEY, persistedSnapshot()); } catch(err){ console.warn('State save skipped', err); } }
function currentKumbh(){ return state.granth.find(k => k.id === state.currentKumbhId) || null; }
function ensureKumbh(){ if(currentKumbh()) return currentKumbh(); const id=(state.granth.at(-1)?.id||0)+1; const k={id,rows:[]}; state.granth.push(k); state.currentKumbhId=id; return k; }
function secondLadderBet(step){ const start=roundUpToCoin(state.settings.max/4,state.settings.coin); if(step<=5) return start; if(step<=10) return Math.min(state.settings.max,start*2); if(step<=15) return Math.min(state.settings.max,start*3); return state.settings.max; }
function currentBetFor(info){ return info.ladder===2 ? secondLadderBet(info.step||1) : (state.ladder[Math.max(0,(info.step||1)-1)]?.bet || state.settings.max); }
function soldierStepNetProfit(info){ const bet=currentBetFor(info); return (bet*8) - (Number(info?.prevLoss) || 0); }
async function askCapDecision(side,num,info){ const stopLossPerNumber=Number(state.settings.stopLossPerNumber); if(state.settings.capRule!=='on' || info.ladder!==1 || !Number.isFinite(stopLossPerNumber)) return false; const stepNetProfit=soldierStepNetProfit(info); if(stepNetProfit>stopLossPerNumber) return false; const capNow=await askModal({ title:'CAP DECISION', text:`${side}${num} step net profit ${stepNetProfit}. Stop Loss / Number ${stopLossPerNumber}. CAP now?`, okLabel:'Now', cancelLabel:'Next', okClass:'warn' }); return !!capNow; }
async function askCapReturnDecision(side,num){ return !!(await askModal({ title:'CAP RETURN DECISION', text:`${side}${num} came back on track. Return this number to betting?`, okLabel:'Return', cancelLabel:'Stay CAP', okClass:'warn' })); }
function nextExposureTotal(){ let total=0; ['Y','K'].forEach(side=>{ for(let n=1;n<=9;n++){ const info=state.numbers[side][n]; if(info.status==='A' || info.status==='B') total += currentBetFor(info); }}); return total; }
function previewNextAhutiFor(info){
  if(!info || (info.status!=='A' && info.status!=='B')) return null;
  if(info.ladder===2){
    const step = Math.max(1, Number(info.step)||1);
    return { stepLabel:`2S${step}`, bet: secondLadderBet(step) };
  }
  const step = Math.max(1, (Number(info.step)||0) + 1);
  return { stepLabel:`S${step}`, bet: state.ladder[Math.max(0, step-1)]?.bet || state.settings.max };
}
function nextPreviewExposureTotal(){
  let total=0;
  ['Y','K'].forEach(side=>{ for(let n=1;n<=9;n++){
    const info=state.numbers[side][n];
    const preview=previewNextAhutiFor(info);
    if(preview) total += preview.bet;
  }});
  return total;
}

function showToast(title,text,kind=''){
  const layer=q('toastLayer'); const el=document.createElement('div'); el.className=`toast ${kind}`; el.innerHTML=`<div class="title">${title}</div><div>${text}</div>`; layer.appendChild(el); setTimeout(()=>el.remove(),3600);
}
function glowKey(el){ if(!el) return; el.classList.remove('key-glow'); void el.offsetWidth; el.classList.add('key-glow'); setTimeout(()=>el.classList.remove('key-glow'),220); }
function statusCode(info){ if(!info) return '0'; if(info.status==='W') return waitingCodeForInfo(info); if(info.status==='A') return `S${Math.max(1, Number(info.step)||1)}`; if(info.status==='B') return 'B'; return info.status; }
function vijayDarshanaDisplay(info){ const bet=currentBetFor(info); const displayStep=Math.max(1,(Number(info.step)||1)-1); const displayNet=(bet*8)-(Number(info.prevLoss)||0); return { bet, displayStep, displayNet }; }

function renderBoards(){
  ['Y','K'].forEach(side=>{
    const host=q(side==='Y'?'boardY':'boardK'); host.innerHTML='';
    for(let i=1;i<=10;i++){
      const n=i===10?0:i; const info=n===0?null:state.numbers[side][n];
      const btn=document.createElement('button'); const code=n===0?'0':statusCode(info); const metaClass=info?.step?`step${Math.min(info.step,6)}`:'';
      btn.type='button'; btn.className=`tile ${n===0?'zero':''} ${info?'state-'+info.status:''}`.trim(); btn.dataset.side=side; btn.dataset.num=String(n);
      btn.innerHTML=`<div class="num">${n}</div><div class="meta ${metaClass}">${code}</div>`;
      host.appendChild(btn);
    }
  });
}
function renderVyuha(){ ['Y','K'].forEach(side=>{ const host=q(side==='Y'?'vyuhaY':'vyuhaK'); host.innerHTML=''; for(let n=1;n<=9;n++){ const info=state.numbers[side][n]; const d=document.createElement('div'); d.className='state-cell'; d.innerHTML=`<div class="num">${n}</div><div class="meta">${statusCode(info)}</div>`; host.appendChild(d);} }); }
function formatNextAhuti(side){ const groups=new Map(); for(let n=1;n<=9;n++){ const info=state.numbers[side][n]; const preview=previewNextAhutiFor(info); if(preview){ if(!groups.has(preview.bet)) groups.set(preview.bet,[]); groups.get(preview.bet).push(`${n}(${preview.stepLabel})`); } } const parts=[...groups.entries()].sort((a,b)=>b[0]-a[0]).map(([bet,arr])=>`${bet} on ${arr.join(' ')}`); return `${side} ${parts.join(' | ') || '-'}`; }
function renderSangram(){ q('bankValue').textContent=fmtMoney(state.liveBankroll); q('chakraValue').textContent=`Round : ${state.currentChakra}`; q('nextY').textContent=formatNextAhuti('Y'); q('nextK').textContent=formatNextAhuti('K'); q('nextT').textContent=`T ${nextPreviewExposureTotal()}`; const lastRow=currentKumbh()?.rows?.at(-1); const last = lastRow ? `${lastRow.y ?? '-'} | ${lastRow.k ?? '-'}` : '-'; if(q('lastResultValue')) q('lastResultValue').textContent=last; }
function sideStatsSummary(counts){
  const entries = Object.entries(counts).filter(([n])=>n!=='0');
  return {
    hot: entries.filter(([,v])=>v>=4).map(([n,v])=> `${n}(${v})`),
    cool: entries.filter(([,v])=>v<4).map(([n,v])=> `${n}(${v})`)
  };
}
function formatRoundInfoEntries(entries){ return entries.length ? entries.join(' | ') : '-'; }
function kumbhInsights(rows){
  const sortedRows = [...(rows||[])].sort((a,b)=>(Number(a.chakra)||0)-(Number(b.chakra)||0));
  const rowMeta = new Map();
  const counts = {
    Y: Object.fromEntries(Array.from({length:10},(_,i)=>[String(i),0])),
    K: Object.fromEntries(Array.from({length:10},(_,i)=>[String(i),0]))
  };
  const lifecycle = {
    Y: Object.fromEntries(Array.from({length:10},(_,i)=>[String(i), {selectedRound:null, hitRound:null}])),
    K: Object.fromEntries(Array.from({length:10},(_,i)=>[String(i), {selectedRound:null, hitRound:null}]))
  };
  const details = { Y: [], K: [] };

  function processSide(side, value, chakra, meta){
    if(value === '-' || value === '' || value === null || value === undefined) return;
    const num = Number(value);
    if(!Number.isFinite(num) || num < 1 || num > 9) return;
    counts[side][String(num)] += 1;
    const key = side==='Y' ? 'y' : 'k';
    const life = lifecycle[side][String(num)];
    if(life.selectedRound === null){
      life.selectedRound = chakra;
      meta[`${key}SelCode`] = `S${num}S1`;
    } else if(life.hitRound === null){
      const travel = chakra - life.selectedRound;
      life.hitRound = chakra;
      meta[`${key}HitCode`] = `H${num}S${travel}`;
      details[side].push({
        side,
        number: num,
        selectedRound: life.selectedRound,
        hitRound: chakra,
        travelSteps: travel,
        selectCode: `S${num}S1`,
        hitCode: `H${num}S${travel}`
      });
    }
  }

  for(const row of sortedRows){
    const chakra = Number(row.chakra)||0;
    const meta = {
      ySelCode:'-', yHitCode:'-',
      kSelCode:'-', kHitCode:'-',
      capped:Array.isArray(row.cap) ? row.cap : (row.cap ? [row.cap] : []),
      returned:Array.isArray(row.ret) ? row.ret : (row.ret ? [row.ret] : [])
    };
    processSide('Y', row.y, chakra, meta);
    processSide('K', row.k, chakra, meta);
    rowMeta.set(chakra, meta);
  }

  return { rowMeta, counts, details, yStats: sideStatsSummary(counts.Y), kStats: sideStatsSummary(counts.K) };
}
function renderGranth(){
  const host=q('granthList'); host.innerHTML='';
  const sel=q('deleteKumbhSelect');
  if(sel){
    sel.innerHTML='<option value=>Select Kumbh</option>';
    state.granth.forEach(k=>{ const op=document.createElement('option'); op.value=String(k.id); op.textContent=`#${String(k.id).padStart(2,'0')} Kumbh`; sel.appendChild(op); });
  }
  const items=[...state.granth].reverse();
  if(!items.length){ host.innerHTML='<div class="kumbh">No Kumbh history yet.</div>'; return; }
  items.forEach(k=>{
    const wrap=document.createElement('div'); wrap.className='kumbh';
    const insight=kumbhInsights(k.rows||[]);
    const rows=[...(k.rows||[])].reverse().map(r=>{
      const meta=insight.rowMeta.get(Number(r.chakra)) || { ySelCode:'-', yHitCode:'-', kSelCode:'-', kHitCode:'-', capped:[], returned:[] };
      return `<tr><td>${r.chakra}</td><td>${r.y ?? '-'}</td><td>${r.k ?? '-'}</td><td>${meta.ySelCode}</td><td>${meta.yHitCode}</td><td>${meta.kSelCode}</td><td>${meta.kHitCode}</td><td>${formatRoundInfoEntries(meta.capped)}</td><td>${formatRoundInfoEntries(meta.returned)}</td><td>${formatRoundInfoEntries(Array.isArray(r.np)?r.np:(r.np?[r.np]:[]))}</td><td>${r.axyapatra ?? '-'}</td></tr>`;
    }).join('');
    const yRpt=Object.entries(insight.counts.Y).filter(([n])=>n!=='0').map(([n,c])=>`<span class="repeat-pill">${n}:${c}</span>`).join('');
    const kRpt=Object.entries(insight.counts.K).filter(([n])=>n!=='0').map(([n,c])=>`<span class="repeat-pill">${n}:${c}</span>`).join('');
    const travelRows = [...insight.details.Y, ...insight.details.K].sort((a,b)=>a.hitRound-b.hitRound).map(d=>`<tr><td>${d.side}</td><td>${d.number}</td><td>${d.selectedRound}</td><td>${d.hitRound}</td><td>${d.travelSteps}</td></tr>`).join('') || '<tr><td colspan="5">No completed travel yet.</td></tr>';
    wrap.innerHTML=`<div class="label">#${String(k.id).padStart(2,'0')} Kumbh</div><div class="table-wrap compact-table"><table><thead><tr><th>R</th><th>Y</th><th>K</th><th>YSel</th><th>YHit</th><th>KSel</th><th>KHit</th><th>Cap</th><th>Ret</th><th>NP</th><th>Ax</th></tr></thead><tbody>${rows}</tbody></table></div><div class="granth-summary"><div class="summary-row"><span class="summary-label">Y Hot</span><span>${insight.yStats.hot.join(' | ') || '-'}</span></div><div class="summary-row"><span class="summary-label">Y Cool</span><span>${insight.yStats.cool.join(' | ') || '-'}</span></div><div class="summary-row summary-repeat"><span class="summary-label">Y Rpt</span><div class="repeat-grid">${yRpt}</div></div><div class="summary-row"><span class="summary-label">K Hot</span><span>${insight.kStats.hot.join(' | ') || '-'}</span></div><div class="summary-row"><span class="summary-label">K Cool</span><span>${insight.kStats.cool.join(' | ') || '-'}</span></div><div class="summary-row summary-repeat"><span class="summary-label">K Rpt</span><div class="repeat-grid">${kRpt}</div></div></div><div class="table-wrap compact-table"><table><thead><tr><th>Side</th><th>Number</th><th>SelectedRound</th><th>HitRound</th><th>TravelSteps</th></tr></thead><tbody>${travelRows}</tbody></table></div>`;
    host.appendChild(wrap);
  });
}

function renderDrishti(){ q('sumChakras').textContent=Math.max(0,state.currentChakra); q('sumAhuti').textContent=state.summary.totalAhuti; q('sumProfit').textContent=state.liveBankroll-state.settings.bankroll; q('sumExposure').textContent=state.summary.maxExposure; const tbody=q('drishtiTable').querySelector('tbody'); tbody.innerHTML=''; [...state.drishti].reverse().forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.side}</td><td>${r.number}</td><td>${r.activationChakra}</td><td>${r.winChakra}</td><td>${r.steps}</td><td>${r.prevLoss}</td><td>${r.winBet}</td><td>${r.net}</td><td>${r.status}</td>`; tbody.appendChild(tr); }); }
function renderSopana(){ const tbody=q('ladderTable').querySelector('tbody'); tbody.innerHTML=''; state.ladder.forEach((row,idx)=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${row.step}</td><td><input class="ladder-bet-input" type="number" data-ladder-index="${idx}" inputmode="numeric" enterkeyhint="next" value="${row.bet}"></td><td>${row.winReturn}</td><td>${row.netProfit}</td><td>${row.ifLoseTotal}</td>`; tbody.appendChild(tr); }); const secondTable=q('secondLadderTable'); if(secondTable){ const tbody2=secondTable.querySelector('tbody'); tbody2.innerHTML=''; let prevLoss=0; for(let i=1;i<=Math.min(state.settings.maxSteps,15);i++){ const bet=secondLadderBet(i); const winReturn=bet*9; prevLoss += bet; const tr=document.createElement('tr'); tr.innerHTML=`<td>S${i}</td><td><input class="ladder-bet-input" type="number" data-second-ladder-index="${i-1}" inputmode="numeric" enterkeyhint="next" value="${bet}"></td><td>${winReturn}</td><td>${winReturn - prevLoss}</td><td>${-prevLoss}</td>`; tbody2.appendChild(tr); } } }
function renderYantra(){ const s=state.settings; q('setBankroll').value=s.bankroll; q('setTargetDollar').value=s.targetDollar; q('setTargetPercent').value=s.targetPercent; q('setStopLoss').value=s.stopLoss; q('setMin').value=s.min; q('setMax').value=s.max; q('setCoin').value=s.coin; q('setTargetNum').value=s.targetNum; q('setDoubleLadder').value=s.doubleLadder||'on'; q('setKeypadMode').value=s.keypadMode; q('setMaxSteps').value=s.maxSteps; q('setReserve').value=s.reserve; q('setCapRule').value=s.capRule; if(q('setStopLossPerNumber')) q('setStopLossPerNumber').value=s.stopLossPerNumber ?? -100; if(q('setAttackMode')) q('setAttackMode').value=s.attackMode || 'classic'; }
function renderMedha(){ const active=[]; const cap=[]; ['Y','K'].forEach(side=>{ for(let n=1;n<=9;n++){ const info=state.numbers[side][n]; if(info.status==='A'||info.status==='B') active.push(`${side}${n} ${info.ladder===2?'2S':'S'}${info.step}`); if(info.status==='C') cap.push(`${side}${n}`);} }); q('medhaPanel').innerHTML=`<div class="medha-item"><div class="label">Active Formation</div><div>${active.join(' | ') || 'None'}</div></div><div class="medha-item"><div class="label">CAP Numbers</div><div>${cap.join(' | ') || 'None'}</div></div>`; }
function renderActiveTab(){ document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===`screen-${state.activeTab}`)); document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.target===state.activeTab)); q('screenTitle').textContent=titles[state.activeTab]||titles.sangram; }
function renderAll(){ renderActiveTab(); renderBoards(); renderVyuha(); renderSangram(); renderGranth(); renderDrishti(); renderSopana(); renderYantra(); renderMedha(); saveState(); }

function startPrayoga(){ if(state.currentChakra===0 && !(currentKumbh()?.rows?.length)){ state.liveBankroll = state.settings.bankroll; } else if(state.currentChakra!==0 || currentKumbh()?.rows?.length){ state.currentKumbhId=null; state.liveBankroll = state.settings.bankroll; state.currentChakra=0; state.numbers={Y:createSide(),K:createSide()}; state.drishti=[]; state.summary={totalAhuti:0,maxExposure:0}; pending={Y:null,K:null}; } const kumbh=ensureKumbh(); state.activeTab='sangram'; renderAll(); showToast('SANGRAM AARAMBHA', `#${String(kumbh.id).padStart(2,'0')} Kumbh ready`); }
async function clearCurrentSession(){ if(!(await askClearKumbh())) return; state.liveBankroll=state.settings.bankroll; state.currentChakra=0; state.numbers={Y:createSide(),K:createSide()}; state.drishti=[]; state.summary={totalAhuti:0,maxExposure:0}; pending={Y:null,K:null}; state.currentKumbhId=null; const kumbh=ensureKumbh(); state.activeTab='sangram'; renderAll(); showToast('KUMBHA SHUDDHI',`#${String(kumbh.id).padStart(2,'0')} Kumbh ready`); }
function recordSnapshot(){ historyStack.push(historySnapshot()); if(historyStack.length>20) historyStack.shift(); redoStack = []; }
function undoLast(){ const prev=historyStack.pop(); if(!prev) return; redoStack.push(historySnapshot()); restoreSnapshot(prev); renderAll(); showToast('CHAKRA PUNARAVRITTI','Last chakra reverted'); }
function redoLast(){ const next=redoStack.pop(); if(!next) return; historyStack.push(historySnapshot()); restoreSnapshot(next); renderAll(); showToast('CHAKRA PUNARAGAMANA','Last chakra restored'); }

function pushDrishti(rec){ state.drishti.push(rec); }
async function resolveNumber(side,num,notes,rowEvents){ const info=state.numbers[side][num]; if(info.status==='L'){ return; }
  if(info.status==='C'){
    const shouldReturn = await askCapReturnDecision(side,num);
    if(!shouldReturn) return;
    info.status='B'; info.ladder=2; info.step=1; info.pendingSecond=false; if(rowEvents) rowEvents.ret.push(`${side}${num}`); notes.push({title:'CAP RETURNED',text:`${side}${num} back on track`,kind:'warn'}); return;
  }
  const mode = getAttackMode();
  const threshold = attackThresholdForMode(mode);
  if(info.status==='I'){
    if(threshold===1){
      activateTrackedNumber(info);
    } else {
      info.status='W';
      info.watchCount = 1;
      info.activeAt = null;
      info.prevLoss = 0;
      info.step = 0;
      info.ladder = 1;
    }
    return;
  }
  if(info.status==='W'){
    info.watchCount = Number(info.watchCount||0) + 1;
    if(info.watchCount >= threshold){
      activateTrackedNumber(info);
    }
    return;
  }
  const bet=currentBetFor(info); const totalReturn=bet*9; const net=(bet*8)-info.prevLoss;
  state.liveBankroll += totalReturn;
  info.winningBet=bet; info.lastNet=net; pushDrishti({ side, number:num, activationChakra:info.activeAt ?? state.currentChakra, winChakra:state.currentChakra, steps:info.step, prevLoss:info.prevLoss, winBet:bet, net, status:'WIN' });
  if(rowEvents) rowEvents.np.push(`${side}${num} ${net >= 0 ? '+' : ''}${net}`);
  const vd=vijayDarshanaDisplay(info);
  info.status='L'; notes.push({title:'VIJAY DARSHANA', text:`${side}${num} ${info.ladder===2?'2S':'S'}${vd.displayStep} Āhuti ${vd.bet} Net +${vd.displayNet}`}); }
async function advanceAfterLoss(side,notes,rowEvents,winningNum=null){ for(let n=1;n<=9;n++){ if(winningNum!==null && Number(winningNum)===n) continue; const info=state.numbers[side][n]; if(info.status!=='A' && info.status!=='B') continue; const bet=currentBetFor(info); info.prevLoss += bet; info.step += 1; if(info.ladder===1){ if(await askCapDecision(side,n,info)){ info.status='C'; pushDrishti({ side, number:n, activationChakra:info.activeAt ?? '-', winChakra:'-', steps:info.step, prevLoss:info.prevLoss, winBet:'-', net:soldierStepNetProfit(info), status:'CAP' }); if(rowEvents){ rowEvents.cap.push(`${side}${n}`); rowEvents.np.push(`${side}${n} ${soldierStepNetProfit(info) >= 0 ? '+' : ''}${soldierStepNetProfit(info)}`); } notes.push({title:'REKHA BANDHA', text:`${side}${n} reached CAP`, kind:'warn'}); } else if(info.step>state.settings.maxSteps){ info.status='C'; pushDrishti({ side, number:n, activationChakra:info.activeAt ?? '-', winChakra:'-', steps:state.settings.maxSteps, prevLoss:info.prevLoss, winBet:'-', net:soldierStepNetProfit(info), status:'CAP' }); if(rowEvents){ rowEvents.cap.push(`${side}${n}`); rowEvents.np.push(`${side}${n} ${soldierStepNetProfit(info) >= 0 ? '+' : ''}${soldierStepNetProfit(info)}`); } notes.push({title:'REKHA BANDHA', text:`${side}${n} reached CAP`, kind:'warn'}); }
      else info.status='A';
    } else { if(info.step>15) info.step=15; info.status='B'; }
  } }
async function processCombined(){ if(pending.Y===null || pending.K===null) return; recordSnapshot(); state.currentChakra += 1; ensureKumbh(); const y=pending.Y, k=pending.K; pending={Y:null,K:null}; let exposure=nextExposureTotal(); state.liveBankroll -= exposure; state.summary.totalAhuti += exposure; state.summary.maxExposure = Math.max(state.summary.maxExposure, exposure); const notes=[]; const rowEvents={cap:[],ret:[],np:[]}; if(y===0) await advanceAfterLoss('Y',notes,rowEvents); else { await advanceAfterLoss('Y',[],rowEvents,y); await resolveNumber('Y',y,notes,rowEvents); } if(k===0) await advanceAfterLoss('K',notes,rowEvents); else { await advanceAfterLoss('K',[],rowEvents,k); await resolveNumber('K',k,notes,rowEvents); }
  currentKumbh()?.rows.push({ chakra:state.currentChakra, y, k, cap:rowEvents.cap, ret:rowEvents.ret, np:rowEvents.np, ahuti:exposure, axyapatra:state.liveBankroll });
  if(state.liveBankroll <= state.settings.bankroll - state.settings.stopLoss) notes.push({title:'TREASURY WARNING',text:'Axyapatra approaching Raksha Rekha',kind:'warn'});
  if(state.liveBankroll < state.settings.reserve) notes.push({title:'TREASURY WARNING',text:'Axyapatra below Raksha Nidhi',kind:'warn'});
  renderAll(); notes.forEach(n=>showToast(n.title,n.text,n.kind||'')); }
async function processIndividual(side,num){ recordSnapshot(); state.currentChakra += 1; ensureKumbh(); let exposure=0; for(let n=1;n<=9;n++){ const info=state.numbers[side][n]; if(info.status==='A'||info.status==='B') exposure += currentBetFor(info); }
  state.liveBankroll -= exposure; state.summary.totalAhuti += exposure; state.summary.maxExposure = Math.max(state.summary.maxExposure, exposure); const notes=[]; const rowEvents={cap:[],ret:[],np:[]}; if(num===0) await advanceAfterLoss(side,notes,rowEvents); else { await advanceAfterLoss(side,[],rowEvents,num); await resolveNumber(side,num,notes,rowEvents); }
  currentKumbh()?.rows.push({ chakra:state.currentChakra, y: side==='Y'?num:'-', k: side==='K'?num:'-', cap:rowEvents.cap, ret:rowEvents.ret, np:rowEvents.np, ahuti:exposure, axyapatra:state.liveBankroll });
  renderAll(); notes.forEach(n=>showToast(n.title,n.text,n.kind||'')); }
function flashLockedKey(el){ if(!el) return; el.classList.add('key-locked-flash'); setTimeout(()=>el.classList.remove('key-locked-flash'), 220); }

async function handleTap(side,num,el){
  if(keypadBusy) return;
  const isLockedTap = num!==0 && state?.numbers?.[side]?.[num]?.status==='L';
  keypadBusy = true;
  try{
    if(isLockedTap) flashLockedKey(el);
    else glowKey(el);
    if(document.activeElement instanceof HTMLElement && document.activeElement !== el) document.activeElement.blur();
    if(state.settings.keypadMode==='combined'){
      pending[side]=num;
      renderSangram();
      if(pending.Y!==null && pending.K!==null) await processCombined();
    } else {
      await processIndividual(side,num);
      renderSangram();
    }
  } catch(err){
    console.error('Keypad entry failed', err);
    showToast('ENTRY WARNING', (err && err.message) ? err.message : 'Entry kept unchanged', 'warn');
  } finally {
    keypadBusy = false;
  }
}

function switchTab(target){ state.activeTab=target; renderActiveTab(); saveState(); }
function setupTabs(){ document.querySelectorAll('.nav').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.target))); }
function setupBoards(){
  ['boardY','boardK'].forEach(id=>{
    const host=q(id);
    if(!host) return;
    host.addEventListener('click', e=>{
      const btn=e.target.closest('button.tile');
      if(!(btn instanceof HTMLButtonElement) || !host.contains(btn)) return;
      const side=btn.dataset.side;
      const num=Number(btn.dataset.num);
      if((side!=='Y' && side!=='K') || !Number.isFinite(num)) return;
      handleTap(side,num,btn);
    });
  });
}
function recalcTargetLink(source){ const bankroll=Number(q('setBankroll').value)||defaultSettings.bankroll; if(source==='dollar') q('setTargetPercent').value=((Number(q('setTargetDollar').value||0)/bankroll)*100).toFixed(2); if(source==='percent') q('setTargetDollar').value=Math.round((bankroll*Number(q('setTargetPercent').value||0))/100); }
function normalizeLadderBet(value){ return Math.max(state.settings.coin, Number(value)||0); }
function syncFirstLadderFromInputs(){
  let cumulative=0;
  document.querySelectorAll('[data-ladder-index]').forEach(inp=>{
    const i=Number(inp.dataset.ladderIndex);
    const bet=normalizeLadderBet(inp.value);
    cumulative += bet;
    state.ladder[i]={ step:`S${i+1}`, bet, winReturn: bet*9, netProfit:(bet*9)-cumulative, ifLoseTotal:-cumulative };
  });
}
function refreshFirstLadderPreview(){
  let cumulative=0;
  document.querySelectorAll('[data-ladder-index]').forEach(inp=>{
    const bet=normalizeLadderBet(inp.value);
    cumulative += bet;
    const row=inp.closest('tr');
    if(!row) return;
    const cells=row.querySelectorAll('td');
    if(cells[2]) cells[2].textContent=String(bet*9);
    if(cells[3]) cells[3].textContent=String((bet*9)-cumulative);
    if(cells[4]) cells[4].textContent=String(-cumulative);
  });
}
function refreshLinkedLadderCalculations(){
  syncFirstLadderFromInputs();
  refreshFirstLadderPreview();
  const hasRecordedRows = state.granth.some(k => Array.isArray(k.rows) && k.rows.length);
  if(hasRecordedRows) replayAllKumbhsWithCurrentSettings();
  renderVyuha();
  renderSangram();
  renderGranth();
  renderDrishti();
  renderMedha();
  saveState();
}


function shouldCapNowSilent(side,num,info){
  const stopLossPerNumber = Number(state.settings.stopLossPerNumber);
  if(state.settings.capRule==='on' && info.ladder===1 && Number.isFinite(stopLossPerNumber)){
    if(soldierStepNetProfit(info) <= stopLossPerNumber) return true;
  }
  return info.ladder===1 && info.step>state.settings.maxSteps;
}
function resolveNumberSilent(side,num,rowEvents,shouldReturnFromCap=false){
  const info=state.numbers[side][num];
  if(!info || info.status==='L') return;
  if(info.status==='C'){
    if(!shouldReturnFromCap) return;
    info.status='B';
    info.ladder=2;
    info.step=1;
    info.pendingSecond=false;
    if(rowEvents) rowEvents.ret.push(`${side}${num}`);
    return;
  }
  const mode = getAttackMode();
  const threshold = attackThresholdForMode(mode);
  if(info.status==='I'){
    if(threshold===1){
      activateTrackedNumber(info);
    } else {
      info.status='W';
      info.watchCount = 1;
      info.activeAt = null;
      info.prevLoss = 0;
      info.step = 0;
      info.ladder = 1;
    }
    return;
  }
  if(info.status==='W'){
    info.watchCount = Number(info.watchCount||0) + 1;
    if(info.watchCount >= threshold){
      activateTrackedNumber(info);
    }
    return;
  }
  const bet=currentBetFor(info);
  const totalReturn=bet*9;
  const net=(bet*8)-info.prevLoss;
  state.liveBankroll += totalReturn;
  info.winningBet=bet;
  info.lastNet=net;
  pushDrishti({ side, number:num, activationChakra:info.activeAt ?? state.currentChakra, winChakra:state.currentChakra, steps:info.step, prevLoss:info.prevLoss, winBet:bet, net, status:'WIN' });
  if(rowEvents) rowEvents.np.push(`${side}${num} ${net >= 0 ? '+' : ''}${net}`);
  info.status='L';
}
function advanceAfterLossSilent(side,rowEvents,winningNum=null){
  for(let n=1;n<=9;n++){
    if(winningNum!==null && Number(winningNum)===n) continue;
    const info=state.numbers[side][n];
    if(info.status!=='A' && info.status!=='B') continue;
    const bet=currentBetFor(info);
    info.prevLoss += bet;
    info.step += 1;
    if(info.ladder===1){
      if(shouldCapNowSilent(side,n,info)){
        const cappedAt = info.step>state.settings.maxSteps ? state.settings.maxSteps : info.step;
        info.status='C';
        pushDrishti({ side, number:n, activationChakra:info.activeAt ?? '-', winChakra:'-', steps:cappedAt, prevLoss:info.prevLoss, winBet:'-', net:soldierStepNetProfit(info), status:'CAP' }); if(rowEvents){ rowEvents.cap.push(`${side}${n}`); rowEvents.np.push(`${side}${n} ${soldierStepNetProfit(info) >= 0 ? '+' : ''}${soldierStepNetProfit(info)}`); }
      } else {
        info.status='A';
      }
    } else {
      if(info.step>15) info.step=15;
      info.status='B';
    }
  }
}

function replayKumbhRowsWithCurrentSettings(kumbh){
  state.liveBankroll = state.settings.bankroll;
  state.currentChakra = 0;
  state.numbers = { Y: createSide(), K: createSide() };
  state.drishti = [];
  state.summary = { totalAhuti: 0, maxExposure: 0 };
  const rows = [...(kumbh?.rows || [])].sort((a,b)=>Number(a.chakra)-Number(b.chakra));
  for(const row of rows){
    if(state.settings.keypadMode === 'combined'){
      const y = Number(row.y);
      const k = Number(row.k);
      state.currentChakra += 1;
      const exposure = nextExposureTotal();
      state.liveBankroll -= exposure;
      state.summary.totalAhuti += exposure;
      state.summary.maxExposure = Math.max(state.summary.maxExposure, exposure);
      const rowEvents={cap:[],ret:[],np:[]};
      const priorRet = Array.isArray(row.ret) ? row.ret.slice() : (row.ret ? [row.ret] : []);
      if(y===0) advanceAfterLossSilent('Y',rowEvents); else { advanceAfterLossSilent('Y',rowEvents,y); resolveNumberSilent('Y', y,rowEvents, priorRet.includes(`Y${y}`)); }
      if(k===0) advanceAfterLossSilent('K',rowEvents); else { advanceAfterLossSilent('K',rowEvents,k); resolveNumberSilent('K', k,rowEvents, priorRet.includes(`K${k}`)); }
      row.chakra = state.currentChakra;
      row.cap = rowEvents.cap;
      row.ret = rowEvents.ret;
      row.np = rowEvents.np;
      row.ahuti = exposure;
      row.axyapatra = state.liveBankroll;
    } else {
      const hasY = row.y !== '-' && row.y !== undefined && row.y !== null;
      const hasK = row.k !== '-' && row.k !== undefined && row.k !== null;
      if(hasY){
        const y = Number(row.y);
        state.currentChakra += 1;
        let exposure = 0;
        for(let n=1;n<=9;n++){
          const info = state.numbers.Y[n];
          if(info.status==='A'||info.status==='B') exposure += currentBetFor(info);
        }
        state.liveBankroll -= exposure;
        state.summary.totalAhuti += exposure;
        state.summary.maxExposure = Math.max(state.summary.maxExposure, exposure);
        const rowEvents={cap:[],ret:[],np:[]};
        const priorRet = Array.isArray(row.ret) ? row.ret.slice() : (row.ret ? [row.ret] : []);
        if(y===0) advanceAfterLossSilent('Y',rowEvents); else { advanceAfterLossSilent('Y',rowEvents,y); resolveNumberSilent('Y', y,rowEvents, priorRet.includes(`Y${y}`)); }
        row.chakra = state.currentChakra;
        row.cap = rowEvents.cap;
        row.ret = rowEvents.ret;
        row.np = rowEvents.np;
        row.ahuti = exposure;
        row.axyapatra = state.liveBankroll;
      }
      if(hasK){
        const k = Number(row.k);
        state.currentChakra += 1;
        let exposure = 0;
        for(let n=1;n<=9;n++){
          const info = state.numbers.K[n];
          if(info.status==='A'||info.status==='B') exposure += currentBetFor(info);
        }
        state.liveBankroll -= exposure;
        state.summary.totalAhuti += exposure;
        state.summary.maxExposure = Math.max(state.summary.maxExposure, exposure);
        const rowEvents={cap:[],ret:[],np:[]};
        const priorRet = Array.isArray(row.ret) ? row.ret.slice() : (row.ret ? [row.ret] : []);
        if(k===0) advanceAfterLossSilent('K',rowEvents); else { advanceAfterLossSilent('K',rowEvents,k); resolveNumberSilent('K', k,rowEvents, priorRet.includes(`K${k}`)); }
        row.chakra = state.currentChakra;
        row.cap = rowEvents.cap;
        row.ret = rowEvents.ret;
        row.np = rowEvents.np;
        row.ahuti = exposure;
        row.axyapatra = state.liveBankroll;
      }
    }
  }
}
function replayAllKumbhsWithCurrentSettings(){
  const preserved = {
    granth: clone(state.granth),
    currentKumbhId: state.currentKumbhId,
    activeTab: state.activeTab
  };
  let activeSnapshot = null;
  for(const kumbh of preserved.granth){
    replayKumbhRowsWithCurrentSettings(kumbh);
    if(kumbh.id === preserved.currentKumbhId){
      activeSnapshot = {
        liveBankroll: state.liveBankroll,
        currentChakra: state.currentChakra,
        numbers: clone(state.numbers),
        drishti: clone(state.drishti),
        summary: clone(state.summary)
      };
    }
  }
  state.granth = preserved.granth;
  state.activeTab = preserved.activeTab;
  state.currentKumbhId = preserved.currentKumbhId;
  if(activeSnapshot){
    state.liveBankroll = activeSnapshot.liveBankroll;
    state.currentChakra = activeSnapshot.currentChakra;
    state.numbers = activeSnapshot.numbers;
    state.drishti = activeSnapshot.drishti;
    state.summary = activeSnapshot.summary;
  } else {
    state.liveBankroll = state.settings.bankroll;
    state.currentChakra = 0;
    state.numbers = { Y: createSide(), K: createSide() };
    state.drishti = [];
    state.summary = { totalAhuti: 0, maxExposure: 0 };
  }
}
function ladderCsvContent(){ return ['ladder,step,bet', ...state.ladder.map((row,idx)=>`L1,S${idx+1},${row.bet}`)].join('\n'); }
async function exportLadderCsv(){ syncFirstLadderFromInputs(); const content=ladderCsvContent(); if(window.showSaveFilePicker){ try{ const handle=await window.showSaveFilePicker({ suggestedName:'sopana-ladder.csv', types:[{ description:'CSV Files', accept:{ 'text/csv':['.csv'] } }] }); const writable=await handle.createWritable(); await writable.write(content); await writable.close(); showToast('SOPANA EXPORTED','Ladder CSV saved'); return; }catch(err){ if(err && err.name==='AbortError') return; } } downloadFile('sopana-ladder.csv',content,'text/csv'); showToast('SOPANA EXPORTED','Ladder CSV downloaded'); }
function exportDrishtiCsv(){ const header='Side,Number,ActivationChakra,WinChakra,StepsToWin,PreviousLoss,WinningBet,NetProfitLoss,Status\n'; const rows=state.drishti.map(r=>[r.side,r.number,r.activationChakra,r.winChakra,r.steps,r.prevLoss,r.winBet,r.net,r.status].join(',')).join('\n'); downloadFile('drishti.csv',header+rows,'text/csv'); }
function exportDrishtiPdf(){ const html=`<html><head><title>Drishti</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #888;padding:6px;text-align:left}h1{font-size:20px}</style></head><body><h1>KUBERA WARHUNT V5Pro Final locked - DRISHTI</h1>${q('drishtiTable').outerHTML}</body></html>`; const w=window.open('','_blank'); if(!w) return; w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(), 250); }
function importDrishtiCsv(e){ const file=e.target.files[0]; if(!file) return; file.text().then(text=>{ state.drishti=text.trim().split(/\r?\n/).slice(1).filter(Boolean).map(line=>{ const [side,number,activationChakra,winChakra,steps,prevLoss,winBet,net,status]=line.split(','); return {side,number,activationChakra,winChakra,steps,prevLoss,winBet,net,status}; }); renderAll(); showToast('DRISHTI LOADED','CSV imported'); }); e.target.value=''; }
function escapeCsvValue(value){ const str=String(value ?? ""); return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str; }

function xmlEscape(value){ return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function sheetNameSafe(name, fallback='Sheet1'){
  const cleaned=String(name||fallback).replace(/[\\\/?*\[\]:]/g,' ').trim().slice(0,31);
  return cleaned || fallback;
}
function xlsxCellRef(colIndex,rowIndex){
  let col='';
  let n=colIndex+1;
  while(n>0){ const mod=(n-1)%26; col=String.fromCharCode(65+mod)+col; n=Math.floor((n-1)/26); }
  return `${col}${rowIndex+1}`;
}
function buildSheetXml(rows){
  const sheetRows=rows.map((row,rIdx)=>{
    const cells=row.map((value,cIdx)=>{
      if(value===null || value===undefined || value==='') return '';
      const ref=xlsxCellRef(cIdx,rIdx);
      if(typeof value==='number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rIdx+1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
}
function buildXlsxWorkbook(kumbhs){
  const enc=new TextEncoder();
  const files=[];
  const add=(name,content)=>files.push({name,data:enc.encode(content)});
  const sheetEntries=(kumbhs||[]).length ? kumbhs : [{name:'Kumbh_01', rows:[[ 'No data' ]]}];
  const wbSheets=sheetEntries.map((s,i)=>`<sheet name="${xmlEscape(sheetNameSafe(s.name,`Sheet${i+1}`))}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('');
  const wbRels=sheetEntries.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('');
  const contentOverrides=sheetEntries.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${contentOverrides}</Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now=new Date().toISOString();
  add('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Kubera Warhunt</dc:creator><cp:lastModifiedBy>Kubera Warhunt</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  add('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Kubera Warhunt</Application></Properties>`);
  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}<Relationship Id="rId${sheetEntries.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  add('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`);
  sheetEntries.forEach((sheet,idx)=>add(`xl/worksheets/sheet${idx+1}.xml`, buildSheetXml(sheet.rows)));
  const crcTable=new Uint32Array(256);
  for(let i=0;i<256;i++){
    let c=i;
    for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
    crcTable[i]=c>>>0;
  }
  const crc32=(data)=>{ let c=0xFFFFFFFF; for(let i=0;i<data.length;i++) c=crcTable[(c^data[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };
  const parts=[]; const central=[]; let offset=0;
  const pushU16=(arr,n)=>arr.push(n&255,(n>>>8)&255); const pushU32=(arr,n)=>arr.push(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);
  files.forEach(file=>{
    const nameBytes=enc.encode(file.name); const crc=crc32(file.data); const local=[];
    pushU32(local,0x04034b50); pushU16(local,20); pushU16(local,0); pushU16(local,0); pushU16(local,0); pushU16(local,0); pushU32(local,crc); pushU32(local,file.data.length); pushU32(local,file.data.length); pushU16(local,nameBytes.length); pushU16(local,0);
    parts.push(Uint8Array.from(local), nameBytes, file.data);
    const cent=[]; pushU32(cent,0x02014b50); pushU16(cent,20); pushU16(cent,20); pushU16(cent,0); pushU16(cent,0); pushU16(cent,0); pushU16(cent,0); pushU32(cent,crc); pushU32(cent,file.data.length); pushU32(cent,file.data.length); pushU16(cent,nameBytes.length); pushU16(cent,0); pushU16(cent,0); pushU16(cent,0); pushU16(cent,0); pushU32(cent,0); pushU32(cent,offset);
    central.push(Uint8Array.from(cent), nameBytes);
    offset += local.length + nameBytes.length + file.data.length;
  });
  const centralSize=central.reduce((n,a)=>n+a.length,0); const end=[]; pushU32(end,0x06054b50); pushU16(end,0); pushU16(end,0); pushU16(end,files.length); pushU16(end,files.length); pushU32(end,centralSize); pushU32(end,offset); pushU16(end,0);
  return new Blob([...parts,...central,Uint8Array.from(end)], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function granthWorkbookSheets(){
  return (state.granth||[]).map(k=>{
    const insight=kumbhInsights(k.rows||[]);
    const rows=[];
    rows.push([`Kumbh #${String(k.id).padStart(2,'0')}`]);
    rows.push(['R','Y','K','YSel','YHit','KSel','KHit','Cap','Ret','NP','Ax']);
    (k.rows||[]).forEach(r=>{
      const meta=insight.rowMeta.get(Number(r.chakra)||0) || { ySelCode:'-', yHitCode:'-', kSelCode:'-', kHitCode:'-', capped:[], returned:[] };
      rows.push([Number(r.chakra)||0, r.y ?? '-', r.k ?? '-', meta.ySelCode, meta.yHitCode, meta.kSelCode, meta.kHitCode, formatRoundInfoEntries(meta.capped), formatRoundInfoEntries(meta.returned), formatRoundInfoEntries(Array.isArray(r.np)?r.np:(r.np?[r.np]:[])), Number(r.axyapatra)||0]);
    });
    rows.push([]);
    rows.push(['Travel Details']);
    rows.push(['Side','Number','SelectedRound','HitRound','TravelSteps']);
    const details=[...insight.details.Y, ...insight.details.K].sort((a,b)=>a.hitRound-b.hitRound);
    if(details.length) details.forEach(d=>rows.push([d.side,d.number,d.selectedRound,d.hitRound,d.travelSteps]));
    else rows.push(['No completed travel yet']);
    rows.push([]);
    rows.push(['Y Hot', insight.yStats.hot.join(' | ') || '-']);
    rows.push(['Y Cool', insight.yStats.cool.join(' | ') || '-']);
    rows.push(['Y Rpt', Object.entries(insight.counts.Y).filter(([n])=>n!=='0').map(([n,c])=>`${n}:${c}`).join(' | ') || '-']);
    rows.push(['K Hot', insight.kStats.hot.join(' | ') || '-']);
    rows.push(['K Cool', insight.kStats.cool.join(' | ') || '-']);
    rows.push(['K Rpt', Object.entries(insight.counts.K).filter(([n])=>n!=='0').map(([n,c])=>`${n}:${c}`).join(' | ') || '-']);
    return { name:`Kumbh_${String(k.id).padStart(2,'0')}`, rows };
  });
}

function parseSimpleCsvLines(text){
  const lines=String(text||'').trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map(line=>{
    const out=[]; let cur=''; let inQuotes=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch==='"'){
        if(inQuotes && line[i+1]==='"'){ cur+='"'; i++; }
        else inQuotes=!inQuotes;
      } else if(ch===',' && !inQuotes){ out.push(cur); cur=''; }
      else cur+=ch;
    }
    out.push(cur);
    return out;
  });
}
function granthCsvContent(){
  const header='KumbhId,Chakra,Y,YSel,YHit,K,KSel,KHit,Cap,Ret,NP,Ah,Ax,Side,Number,SelectedRound,HitRound,TravelSteps,SelectCode,HitCode\n';
  const rows=[];
  state.granth.forEach(k=>{
    const insight=kumbhInsights(k.rows||[]);
    const detailMap=new Map();
    [...insight.details.Y, ...insight.details.K].forEach(d=>{
      const key=`${d.side}-${d.hitRound}`;
      if(!detailMap.has(key)) detailMap.set(key, []);
      detailMap.get(key).push(d);
    });
    (k.rows||[]).forEach(r=>{
      const chakra=Number(r.chakra)||0;
      const meta=insight.rowMeta.get(chakra) || { ySelCode:'-', yHitCode:'-', kSelCode:'-', kHitCode:'-', capped:[], returned:[] };
      const details=[...(detailMap.get(`Y-${chakra}`)||[]), ...(detailMap.get(`K-${chakra}`)||[])];
      if(details.length){
        details.forEach(d=>rows.push([k.id,r.chakra,r.y ?? '-',meta.ySelCode,meta.yHitCode,r.k ?? '-',meta.kSelCode,meta.kHitCode,formatRoundInfoEntries(meta.capped),formatRoundInfoEntries(meta.returned),formatRoundInfoEntries(Array.isArray(r.np)?r.np:(r.np?[r.np]:[])),r.ahuti ?? 0,r.axyapatra ?? 0,d.side,d.number,d.selectedRound,d.hitRound,d.travelSteps,d.selectCode,d.hitCode].map(escapeCsvValue).join(',')));
      } else {
        rows.push([k.id,r.chakra,r.y ?? '-',meta.ySelCode,meta.yHitCode,r.k ?? '-',meta.kSelCode,meta.kHitCode,formatRoundInfoEntries(meta.capped),formatRoundInfoEntries(meta.returned),formatRoundInfoEntries(Array.isArray(r.np)?r.np:(r.np?[r.np]:[])),r.ahuti ?? 0,r.axyapatra ?? 0,'','','','','',''].map(escapeCsvValue).join(','));
      }
    });
  });
  return header + rows.join('\n');
}
async function saveWithPicker(name,content,type){ if(window.showSaveFilePicker){ try{ const handle=await window.showSaveFilePicker({ suggestedName:name, types:[{ description:type.includes('json') ? 'JSON Files' : 'CSV Files', accept:{ [type]: [name.endsWith('.json') ? '.json' : '.csv'] } }] }); const writable=await handle.createWritable(); await writable.write(content); await writable.close(); return true; }catch(err){ if(err && err.name==='AbortError') return null; } } return false; }
function exportPayload(){ return { app:'Kubera_V5Pro Final locked', version:'Kubera_V5Pro Final locked', exportedAt:new Date().toISOString(), state, pending, historyStack, redoStack }; }
async function exportGranthJson(){ const content=JSON.stringify(exportPayload(),null,2); const saved=await saveWithPicker('Kubera_V5Pro_Final_locked.json',content,'application/json'); if(saved===null) return; if(!saved) downloadFile('Kubera_V5Pro_Final_locked.json',content,'application/json'); }
async function exportGranthCsv(){ const content=granthCsvContent(); const saved=await saveWithPicker('Kubera_V5Pro_Final_locked.csv',content,'text/csv'); if(saved===null) return; if(!saved) downloadFile('Kubera_V5Pro_Final_locked.csv',content,'text/csv'); }
async function exportGranthXlsx(){ const blob=buildXlsxWorkbook(granthWorkbookSheets()); const saved=await saveWithPicker('Kubera_V5Pro_Final_locked.xlsx',blob,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); if(saved===null) return; if(!saved) downloadBlob('Kubera_V5Pro_Final_locked.xlsx',blob); showToast('GRANTH EXPORTED','XLSX workbook saved'); }
function importGranthJson(e){ const file=e.target.files[0]; if(!file) return; file.text().then(text=>{ const name=(file.name||'').toLowerCase(); const trimmed=text.trim(); if(name.endsWith('.csv') || trimmed.startsWith('KumbhId,')){
      const grouped=new Map(); parseSimpleCsvLines(text).forEach(cols=>{ const kumbhId=Number(cols[0])||0; const chakra=Number(cols[1])||0; if(!kumbhId || !chakra) return; if(!grouped.has(kumbhId)) grouped.set(kumbhId,{id:kumbhId,rows:[]}); const target=grouped.get(kumbhId); if(!target.rows.some(r=>Number(r.chakra)===chakra)) target.rows.push({ chakra, y:(cols[2]==='-'?'':(Number(cols[2])||cols[2])), k:(cols[5]==='-'?'':(Number(cols[5])||cols[5])), cap: cols[8] && cols[8] !== '-' ? cols[8].split(' | ') : [], ret: cols[9] && cols[9] !== '-' ? cols[9].split(' | ') : [], np: cols[10] && cols[10] !== '-' ? cols[10].split(' | ') : [], ahuti:Number(cols[11])||0, axyapatra:Number(cols[12])||0 }); });
      state.granth=[...grouped.values()].sort((a,b)=>a.id-b.id); state.currentKumbhId=state.granth.at(-1)?.id||null; pending={Y:null,K:null}; historyStack=[]; redoStack=[]; replayAllKumbhsWithCurrentSettings();
    } else {
      const parsed=JSON.parse(text);
      if(parsed && parsed.state){ restoreSnapshot(parsed); }
      else if(parsed && parsed.granth){ state = reviveState({ ...freshState(), granth: parsed.granth, currentKumbhId: parsed.granth.at(-1)?.id||null, settings: parsed.settings || state.settings }); pending={Y:null,K:null}; historyStack=[]; redoStack=[]; replayAllKumbhsWithCurrentSettings(); }
      else { state = reviveState(parsed); pending={Y:null,K:null}; historyStack=[]; redoStack=[]; }
    }
    renderAll(); showToast('GRANTH LOADED','History imported'); }).finally(()=>{ e.target.value=''; }); }

function importLadderCsv(e){ const file=e.target.files[0]; if(!file) return; file.text().then(text=>{ const lines=text.trim().split(/\r?\n/).slice(1).filter(Boolean); let cumulative1=0, cumulative2=0; lines.forEach(line=>{ const [ladder,stepLabel,betRaw]=line.split(','); const idx=Math.max(0, Number(String(stepLabel).replace(/\D/g,''))-1); const bet=Number(betRaw)||0; if(String(ladder).trim().toUpperCase()==='L2'){ cumulative2 += bet; } else { cumulative1 += bet; state.ladder[idx] = { step:`S${idx+1}`, bet, winReturn:bet*9, netProfit:(bet*9)-cumulative1, ifLoseTotal:-cumulative1 }; } }); const hasRecordedRows = state.granth.some(k => Array.isArray(k.rows) && k.rows.length); if(hasRecordedRows) replayAllKumbhsWithCurrentSettings(); renderAll(); showToast('SOPANA LOADED','CSV ladder loaded'); }).finally(()=>{ e.target.value=''; }); }
function downloadFile(name,content,type){ const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),500); }
function downloadBlob(name,blob){ const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),500); }
function setupInstall(){ window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredPrompt=e; q('installBtn').classList.remove('hidden'); }); q('installBtn').addEventListener('click', async()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; q('installBtn').classList.add('hidden'); }); }
function readYantraSettings(){
  const current = clone(state.settings);
  const bankrollRaw = Number(q('setBankroll').value);
  current.bankroll = Number.isFinite(bankrollRaw) && bankrollRaw > 0 ? bankrollRaw : defaultSettings.bankroll;
  current.targetDollar = Number(q('setTargetDollar').value)||500;
  current.targetPercent = Number(q('setTargetPercent').value)||1.67;
  current.stopLoss = Number(q('setStopLoss').value)||50000;
  current.min = Number(q('setMin').value)||100;
  current.max = Number(q('setMax').value)||3000;
  current.coin = Number(q('setCoin').value)||100;
  current.targetNum = Number(q('setTargetNum').value)||500;
  current.doubleLadder = q('setDoubleLadder').value || 'on';
  current.keypadMode = q('setKeypadMode').value || 'combined';
  current.maxSteps = Number(q('setMaxSteps').value)||30;
  current.reserve = Number(q('setReserve').value)||20000;
  current.capRule = q('setCapRule').value || 'on';
  if(q('setAttackMode')) current.attackMode = q('setAttackMode').value || 'classic';
  const stopLossPerNumberValue = Number(q('setStopLossPerNumber').value);
  current.stopLossPerNumber = Number.isFinite(stopLossPerNumberValue) ? stopLossPerNumberValue : -100;
  return current;
}
async function applyYantraSettings(){
  if(!(await askApplyYantra())) return;
  state.settings = readYantraSettings();
  state.ladder = buildLadder(state.settings);
  const hasRecordedRows = state.granth.some(k => Array.isArray(k.rows) && k.rows.length);
  if(hasRecordedRows){
    replayAllKumbhsWithCurrentSettings();
  } else {
    state.liveBankroll = state.settings.bankroll;
  }
  renderAll();
  showToast('YANTRA APPLIED','Settings updated');
}

function setupControls(){
  q('prayogaBtn').addEventListener('click', startPrayoga);
  q('kumbhaBtn').addEventListener('click', clearCurrentSession);
  q('undoBtn').addEventListener('click', undoLast);
  q('redoBtn')?.addEventListener('click', redoLast);
  q('setTargetDollar').addEventListener('input', ()=>recalcTargetLink('dollar'));
  q('setTargetPercent').addEventListener('input', ()=>recalcTargetLink('percent'));
  q('setBankroll').addEventListener('input', ()=>recalcTargetLink('dollar'));
  q('applyYantraBtn').addEventListener('click', applyYantraSettings);
  q('saveLadderBtn').addEventListener('click', ()=>{ document.querySelectorAll('[data-ladder-index]').forEach(inp=>{ inp.value=normalizeLadderBet(inp.value); }); syncFirstLadderFromInputs(); const hasRecordedRows = state.granth.some(k => Array.isArray(k.rows) && k.rows.length); if(hasRecordedRows) replayAllKumbhsWithCurrentSettings(); renderAll(); showToast('SOPANA SAVED','Editable ladder updated'); });
  if(q('exportLadderBtn')) q('exportLadderBtn').addEventListener('click', ()=>{ exportLadderCsv(); });
  if(q('loadLadderBtn')) q('loadLadderBtn').addEventListener('click', ()=>q('loadLadderFile').click());
  if(q('loadLadderFile')) q('loadLadderFile').addEventListener('change', importLadderCsv);
  q('resetLadderBtn').addEventListener('click', ()=>{ state.ladder=buildLadder(state.settings); const hasRecordedRows = state.granth.some(k => Array.isArray(k.rows) && k.rows.length); if(hasRecordedRows) replayAllKumbhsWithCurrentSettings(); renderAll(); showToast('SOPANA RESET','Default ladder restored'); });
  document.addEventListener('input', e=>{ const el=e.target; if(!(el instanceof HTMLInputElement)) return; if(!el.matches('[data-ladder-index]')) return; refreshLinkedLadderCalculations(); });
  document.addEventListener('keydown', e=>{ const el=e.target; if(!(el instanceof HTMLInputElement)) return; if(!el.matches('[data-ladder-index]')) return; if(e.key==='Enter'){ e.preventDefault(); const current=Number(el.dataset.ladderIndex); const next=document.querySelector(`[data-ladder-index="${current+1}"]`); if(next){ next.focus(); next.select(); } else { el.blur(); } } });
  document.addEventListener('focusin', e=>{ const el=e.target; if(el instanceof HTMLInputElement && el.matches('[data-ladder-index]')) setTimeout(()=>el.select(),0); });
  q('exportCsvBtn').addEventListener('click', exportDrishtiCsv); if(q('exportPdfBtn')) q('exportPdfBtn').addEventListener('click', exportDrishtiPdf); q('loadCsvBtn').addEventListener('click', ()=>q('loadCsvFile').click()); q('loadCsvFile').addEventListener('change', importDrishtiCsv);
  q('exportGranthBtn').addEventListener('click', ()=>{ const fmt=q('granthExportFormat')?.value || 'json'; if(fmt==='csv') exportGranthCsv(); else if(fmt==='xlsx') exportGranthXlsx(); else exportGranthJson(); }); q('importGranthBtn').addEventListener('click', ()=>q('importGranthFile').click()); q('importGranthFile').addEventListener('change', importGranthJson);
  q('deleteGranthBtn').addEventListener('click', async()=>{ const sel=q('deleteKumbhSelect'); const id=Number(sel?.value||0); if(id){ const ok=await askModal({ title:`Delete Kumbh #${String(id).padStart(2,'0')} ?`, text:'This action will permanently remove this history.', okLabel:'Delete', cancelLabel:'Cancel', okClass:'warn' }); if(!ok) return; state.granth=state.granth.filter(k=>k.id!==id).map((k,idx)=>({ ...k, id: idx+1 })); state.currentKumbhId=state.granth.at(-1)?.id||null; renderAll(); showToast('KUMBH DELETED','Selected Kumbh removed'); return; } const ok=await askModal({ title:'Delete all Kumbh history?', text:'This action will permanently remove this history.', okLabel:'Delete', cancelLabel:'Cancel', okClass:'warn' }); if(!ok) return; state.granth=[]; state.currentKumbhId=null; renderAll(); showToast('GRANTH PURGED','All Kumbh history removed'); });
  q('historyUndoBtn')?.addEventListener('click', undoLast);
  q('confirmCancelBtn').addEventListener('click', ()=>closeClearKumbh(false));
  q('confirmOkBtn').addEventListener('click', ()=>closeClearKumbh(true));
  q('confirmOverlay').addEventListener('click', e=>{ if(e.target===q('confirmOverlay')) closeClearKumbh(false); });
  document.addEventListener('keydown', e=>{ if(q('confirmOverlay').classList.contains('hidden')) return; if(e.key==='Escape') closeClearKumbh(false); });
}

if('serviceWorker' in navigator){ window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{})); }
setupTabs(); setupBoards(); setupControls(); setupInstall(); renderAll();