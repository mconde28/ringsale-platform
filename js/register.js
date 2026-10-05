'use strict';
/* ============================================================================
 * RingSale — multi-tenant register module (window.Register)
 *
 * Owns: the sell screen (menu grid + customization + ticket + tenders), the
 * menu admin, reports, the cash drawer, and close-of-day. Renders into the
 * shell-provided containers: #cat-chips #menu-grid #ticket-lines #ticket-totals
 * #menu-admin-list #reports-body #modal #modal-box #hdr-business.
 *
 * ARCHITECTURE
 *  - Supabase is the source of truth. `DB` below wraps every query; RLS
 *    isolates vendors, and every write carries vendor_id.
 *  - localStorage `ringsale-v1-cache` is a READ cache: {vendorId, menu,
 *    savedAt}. The register paints the cached menu instantly, then refreshes
 *    from Supabase in the background.
 *  - If Supabase is unreachable (boot or mid-day write), we keep selling
 *    against the cache, queue completed sales in localStorage, and replay
 *    them on the next successful load. Best-effort v1 — no full sync engine.
 *  - ITEM CUSTOMIZATIONS (hold-ingredients / add-ons / size options): the
 *    menu_items schema has NO meta/jsonb column for these, and they are
 *    vendor config, not transactional data. So they live client-side in
 *    localStorage (`ringsale-v1-details-<vendorId>`), keyed by menu item id.
 *    v2: add a menu_items.meta jsonb column and move this server-side.
 * ========================================================================== */

const $=s=>document.querySelector(s);
const R=n=>Math.round(n*100)/100;
const M=n=>'$'+R(n).toFixed(2);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const deepCopy=o=>JSON.parse(JSON.stringify(o));
const _made={};   // elements this module created (discount/note/tender rows, offline badge)

/* ---------------- state ---------------- */
const state={vendorId:null,offline:false};
let MENU=[];              // normalized menu items for this vendor
let details={};           // item customizations, keyed by menu item id (see note above)
let ticket=[];            // {key,itemId,name,cat,qty,unit,size,holds[],addons[]}
let discountPct=0;
let ticketNote='';
let sales=[];             // today's sales (normalized)
let closedDays=[];        // closed-day snapshots
let drawerOpening=0;      // opening cash ("the bank"), persisted in drawer_state
let activeCat='All';
let eightysix=false;      // 86 mode: tapping a menu item 86s / un-86s it
let viewingClosed=-1;     // index into closedDays, -1 = live day
let cust=null;            // customization session
let cashTender={total:0,tendered:0};
let cashPad='';
let lastLoc='Main Stall';

const CACHE_KEY='ringsale-v1-cache';
const DETAILS_KEY=v=>'ringsale-v1-details-'+v;
const QUEUE_KEY=v=>'ringsale-v1-queue-'+v;

function localDay(d){d=d||new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function todayStartISO(){const d=new Date();d.setHours(0,0,0,0);return d.toISOString();}

/* ---------------- DB: every Supabase call goes through here ---------------- */
const DB={
  get client(){return (typeof window!=='undefined'&&window.SB&&window.SB.client)||null;},
  _need(){const c=this.client;if(!c)throw new Error('supabase unavailable');return c;},
  async loadMenu(vendorId){
    const r=await this._need().from('menu_items').select('*').eq('vendor_id',vendorId).order('position',{ascending:true});
    if(r.error)throw r.error;
    return (r.data||[]).map(normalizeItem);
  },
  async upsertItem(row){
    const c=this._need();
    const r=row.id
      ? await c.from('menu_items').upsert(row,{onConflict:'id'}).select().single()
      : await c.from('menu_items').insert(row).select().single();
    if(r.error)throw r.error;
    return normalizeItem(r.data);
  },
  async updateItem(id,patch){
    const r=await this._need().from('menu_items').update(patch).eq('id',id).select();
    if(r.error)throw r.error;
    return r.data;
  },
  async deleteItem(id){
    const r=await this._need().from('menu_items').delete().eq('id',id);
    if(r.error)throw r.error;
    return true;
  },
  async recordSale(row){
    const r=await this._need().from('sales').insert(row).select().single();
    if(r.error)throw r.error;
    return r.data;
  },
  async loadTodaySales(vendorId){
    const r=await this._need().from('sales').select('*').eq('vendor_id',vendorId)
      .gte('created_at',todayStartISO()).order('created_at',{ascending:true});
    if(r.error)throw r.error;
    return (r.data||[]).map(normalizeSale);
  },
  async clearTodaySales(vendorId){
    const r=await this._need().from('sales').delete().eq('vendor_id',vendorId).gte('created_at',todayStartISO());
    if(r.error)throw r.error;
    return true;
  },
  async loadClosedDays(vendorId){
    const r=await this._need().from('closed_days').select('*').eq('vendor_id',vendorId).order('day',{ascending:false});
    if(r.error)throw r.error;
    return (r.data||[]).map(normalizeClosedDay);
  },
  async saveClosedDay(row){
    const r=await this._need().from('closed_days').insert(row).select().single();
    if(r.error)throw r.error;
    return r.data;
  },
  async getDrawer(vendorId){
    const r=await this._need().from('drawer_state').select('*').eq('vendor_id',vendorId);
    if(r.error)throw r.error;
    return (r.data&&r.data[0])||null;
  },
  async setDrawer(vendorId,opening){
    const r=await this._need().from('drawer_state')
      .upsert({vendor_id:vendorId,opening:R(opening),updated_at:new Date().toISOString()},{onConflict:'vendor_id'}).select();
    if(r.error)throw r.error;
    return true;
  }
};

/* ---------------- row normalization (Supabase -> register shape) ---------------- */
function normalizeItem(r){
  return {id:r.id,
    name:String(r.name==null?'':r.name),
    cat:String(r.category==null||r.category===''?'Uncategorized':r.category),
    price:(Number(r.price)||0),
    stock:Math.max(0,parseInt(r.stock,10)||0),
    avail:r.avail!==false,
    position:parseInt(r.position,10)||0};
}
function normalizeSale(r){
  return {id:r.id,displayId:null,at:r.created_at?new Date(r.created_at):new Date(),
    lines:Array.isArray(r.lines)?r.lines:[],sub:Number(r.subtotal)||0,disc:Number(r.discount)||0,
    total:Number(r.total)||0,tender:String(r.tender||''),tendered:Number(r.tendered)||0,
    change:Number(r.change)||0,note:String(r.note||'')};
}
function normalizeClosedDay(r){
  return {id:r.id,day:String(r.day||''),at:r.created_at?new Date(r.created_at):new Date(),
    loc:(r.drawer&&r.drawer.loc)||'',
    sales:Array.isArray(r.sales)?r.sales:[],drawer:r.drawer||null};
}

/* ---------------- localStorage: read cache / details / offline queue ---------------- */
function readCache(){
  try{const p=JSON.parse(localStorage.getItem(CACHE_KEY));
    if(p&&p.vendorId===state.vendorId&&Array.isArray(p.menu))return p;}catch(e){}
  return null;
}
function writeCache(){
  try{localStorage.setItem(CACHE_KEY,JSON.stringify({vendorId:state.vendorId,menu:MENU,savedAt:new Date().toISOString()}));}catch(e){}
}
function loadDetails(){
  details={};
  try{const p=JSON.parse(localStorage.getItem(DETAILS_KEY(state.vendorId)));
    if(p&&typeof p==='object')details=p;}catch(e){}
}
function saveDetails(){
  try{localStorage.setItem(DETAILS_KEY(state.vendorId),JSON.stringify(details));}catch(e){}
}
function itemConfig(item){
  const d=details[item.id]||{};
  return {ingredients:Array.isArray(d.ingredients)?d.ingredients:[],
    addons:Array.isArray(d.addons)?d.addons:[],
    opt:(d.opt&&Array.isArray(d.opt.choices))?d.opt:null};
}
function readQueue(){
  try{const q=JSON.parse(localStorage.getItem(QUEUE_KEY(state.vendorId)));
    return Array.isArray(q)?q:[];}catch(e){return[];}
}
function writeQueue(q){
  try{localStorage.setItem(QUEUE_KEY(state.vendorId),JSON.stringify(q));}catch(e){}
}
async function flushQueue(){
  const q=readQueue();
  if(!q.length)return 0;
  const remaining=[];
  for(const row of q){
    try{
      await DB.recordSale(row);
      /* local stock was already decremented when the sale completed offline;
         mirror the same value to Supabase (best-effort) */
      const byId={};
      (row.lines||[]).forEach(function(l){byId[l.itemId]=(byId[l.itemId]||0)+l.qty;});
      for(const id of Object.keys(byId)){
        const it=MENU.find(function(m){return m.id===id;});
        if(it){try{await DB.updateItem(id,{stock:it.stock});}catch(e2){/* best-effort */}}
      }
    }catch(e){remaining.push(row);break;}
  }
  writeQueue(remaining);
  return remaining.length;
}

/* ---------------- modal helpers ---------------- */
let _wired=false;
function wireOnce(){
  if(_wired)return;_wired=true;
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){const m=$('#modal');if(m&&!m.hidden)closeModal();}
  });
  const m=$('#modal');
  if(m&&m.addEventListener)m.addEventListener('click',function(e){if(e.target&&e.target.id==='modal')closeModal();});
  /* shell-provided tender buttons (data-tender) -> openTender */
  const tb=document.querySelectorAll('#tender-row [data-tender]');
  for(let i=0;i<tb.length;i++)(function(b){
    b.addEventListener('click',function(){openTender(b.getAttribute('data-tender'));});
  })(tb[i]);
}
function openModal(html){$('#modal-box').innerHTML=html;$('#modal').hidden=false;}
function closeModal(){const m=$('#modal');if(m)m.hidden=true;const b=$('#modal-box');if(b)b.innerHTML='';}
function modalError(msg){
  openModal('<h2>Couldn\'t reach the server</h2><div class="sub">'+esc(msg)+'</div>'+
   '<div class="modal-actions"><button class="btn primary" onclick="closeModal()">OK</button></div>');
}
/* The shell guarantees the main containers; discount/note/tender rows are
   register-owned — create them if the shell didn't. */
function ensureRow(id,afterSel){
  let el=_made[id]||document.querySelector(id);
  if(!el){
    el=document.createElement('div');el.id=id;_made[id]=el;
    const anchor=document.querySelector(afterSel||'#ticket-lines');
    if(anchor&&anchor.parentNode&&anchor.parentNode.insertBefore)anchor.parentNode.insertBefore(el,anchor.nextSibling);
    else if(document.body&&document.body.appendChild)document.body.appendChild(el);
  }
  return el;
}
function ensureTenderRow(){
  const row=ensureRow('#tender-row','#note-row');
  if(!row.innerHTML){
    row.innerHTML='<button class="tender" onclick="openTender(\'cash\')">Cash</button>'+
      '<button class="tender" onclick="openTender(\'card\')">Card</button>'+
      '<button class="tender" onclick="openTender(\'other\')">Other</button>';
  }
  return row;
}
function showOfflineBadge(){
  if(_made['#offline-badge'])return;
  const h=$('#hdr-business');if(!h||!h.appendChild)return;
  const s=document.createElement('span');s.id='offline-badge';
  s.textContent='Offline — showing cached data';
  h.appendChild(s);_made['#offline-badge']=s;
}
function hideOfflineBadge(){
  const b=_made['#offline-badge'];
  if(b){delete _made['#offline-badge'];if(b.remove)b.remove();}
}

function renderAll(){renderCats();renderMenu();renderTicket();}

/* ---------------- sell: menu grid ---------------- */
function vendorCats(){
  const cs=[];
  MENU.forEach(function(i){if(cs.indexOf(i.cat)<0)cs.push(i.cat);});
  return ['All'].concat(cs);
}
function renderCats(){
  $('#cat-chips').innerHTML=vendorCats().map(function(c){
    return '<button class="chip'+(c===activeCat?' active':'')+'" onclick="setCat(\''+c+'\')">'+esc(c)+'</button>';
  }).join('')+'<button class="chip chip86'+(eightysix?' active':'')+'" onclick="toggle86()">86'+(eightysix?' ON':'')+'</button>';
}
function setCat(c){activeCat=c;renderCats();renderMenu();}
function toggle86(){eightysix=!eightysix;renderCats();renderMenu();}
async function menuTap(id){
  if(eightysix){await toggleAvail(id);return;}
  openCustomize(id);
}
async function toggleAvail(id){
  const it=MENU.find(function(i){return i.id===id;});if(!it)return;
  it.avail=!it.avail;
  try{await DB.updateItem(id,{avail:it.avail});}catch(e){/* offline: local-only, synced on next edit */}
  writeCache();renderMenuAdmin();renderMenu();
}
function isOut(i){return !i.avail||i.stock<=0;}
function renderMenu(){
  const items=MENU.filter(function(i){return activeCat==='All'||i.cat===activeCat;});
  const grid=$('#menu-grid');
  if(grid.classList&&grid.classList.toggle)grid.classList.toggle('mode86',eightysix);
  grid.innerHTML=items.map(function(i){
    const out=isOut(i);
    const st=eightysix?(i.avail?'Tap to 86':'86\u2019d — tap to restore')
      :(i.avail?(i.stock>0?('In stock: '+i.stock):'Out of stock'):'86\u2019d');
    return '<button class="menu-item'+(out?' out':'')+'" onclick="menuTap(\''+i.id+'\')">'+
    '<span class="nm">'+esc(i.name)+'</span>'+
    '<span class="pr">'+M(i.price)+'</span>'+
    '<span class="st">'+st+'</span>'+
    '</button>';
  }).join('')||'<p class="ticket-empty">'+(MENU.length?'No items in this category.':'No menu items yet — add them on the Menu tab.')+'</p>';
}

/* ---------------- item customization ---------------- */
function openCustomize(id){
  const item=MENU.find(function(i){return i.id===id;});
  if(!item||isOut(item))return;
  const cfg=itemConfig(item);
  cust={item:item,qty:1,sizeIdx:0,opt:cfg.opt,ingredients:cfg.ingredients,addonsDef:cfg.addons,
    holds:cfg.ingredients.map(function(){return false;}),
    addons:cfg.addons.map(function(){return{on:false,onSide:false};})};
  renderCustomize();
}
function custUnit(){
  let u=cust.item.price;
  if(cust.opt)u+=cust.opt.choices[cust.sizeIdx].delta;
  cust.addons.forEach(function(a,i){if(a.on)u+=cust.addonsDef[i].price;});
  return R(u);
}
function renderCustomize(){
  const it=cust.item,u=custUnit();
  let optHtml='';
  if(cust.opt){
    optHtml='<div class="opt-group"><div class="glbl">'+esc(cust.opt.label)+'</div>'+
      cust.opt.choices.map(function(c,i){
        return '<label class="opt"><input type="radio" name="custopt"'+(i===cust.sizeIdx?' checked':'')+
        ' onchange="custSize('+i+')"><span>'+esc(c.name)+'</span><span style="margin-left:auto;color:#78716c">'+(c.delta?'+'+M(c.delta):'Included')+'</span></label>';
      }).join('')+'</div>';
  }
  let holdHtml='';
  if(cust.ingredients.length){
    holdHtml='<div class="opt-group"><div class="glbl">Hold (leave off)</div><div class="holds">'+
      cust.ingredients.map(function(g,i){
        const held=cust.holds[i];
        return '<button class="hold'+(held?' held':'')+'" onclick="custHold('+i+')">'+(held?'NO ':'')+esc(g)+'</button>';
      }).join('')+'</div></div>';
  }
  let addonHtml='';
  if(cust.addonsDef.length){
    addonHtml='<div class="opt-group"><div class="glbl">Add-ons</div>'+
      cust.addonsDef.map(function(a,i){
        const st=cust.addons[i];
        return '<div class="addon-row"><input type="checkbox"'+(st.on?' checked':'')+' onchange="custAddon('+i+')">'+
        '<span class="an">'+esc(a.name)+'</span><span class="ap">+'+M(a.price)+'</span>'+
        '<label class="onside"><input type="checkbox"'+(st.onSide?' checked':'')+' onchange="custOnSide('+i+')">On side</label></div>';
      }).join('')+'</div>';
  }
  const det=[];
  if(cust.opt)det.push(esc(cust.opt.choices[cust.sizeIdx].name));
  cust.ingredients.forEach(function(g,i){if(cust.holds[i])det.push('No '+esc(g));});
  cust.addonsDef.forEach(function(a,i){
    if(cust.addons[i].on)det.push(esc(a.name)+(cust.addons[i].onSide?' (on the side)':''));
  });
  openModal(
    '<h2>'+esc(it.name)+'</h2><div class="sub">'+M(it.price)+' base · In stock: '+it.stock+'</div>'+
    optHtml+holdHtml+addonHtml+
    '<div class="preview"><div class="pv-name">'+esc(it.name)+'</div>'+
    '<div class="pv-det">'+(det.join(' · ')||'Classic — no extras')+'</div>'+
    '<div class="pv-price">'+M(u)+' each</div></div>'+
    '<div class="qty" style="margin-bottom:12px"><button onclick="custQty(-1)">−</button><strong>Qty: '+cust.qty+'</strong><button onclick="custQty(1)">+</button></div>'+
    '<div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button>'+
    '<button class="btn primary" onclick="addToTicket()">Add · '+M(R(u*cust.qty))+'</button></div>'
  );
}
function custSize(i){cust.sizeIdx=i;renderCustomize();}
function custQty(d){const it=cust.item;cust.qty=Math.min(Math.max(1,cust.qty+d),Math.max(1,it.stock));renderCustomize();}
function custHold(i){cust.holds[i]=!cust.holds[i];renderCustomize();}
function custAddon(i){cust.addons[i].on=!cust.addons[i].on;if(!cust.addons[i].on)cust.addons[i].onSide=false;renderCustomize();}
function custOnSide(i){const st=cust.addons[i];if(!st.on){st.on=true;st.onSide=true;}else{st.onSide=!st.onSide;}renderCustomize();}
function addToTicket(){
  const it=cust.item,u=custUnit();
  const addons=cust.addonsDef.filter(function(a,i){return cust.addons[i].on;}).map(function(a){
    const idx=cust.addonsDef.indexOf(a);
    return{name:a.name,price:a.price,onSide:cust.addons[idx].onSide};
  });
  const holds=cust.ingredients.filter(function(g,i){return cust.holds[i];});
  const line={
    key:'L'+Date.now()+Math.floor(Math.random()*999),
    itemId:it.id,name:it.name,cat:it.cat,qty:cust.qty,unit:u,
    size:cust.opt?cust.opt.choices[cust.sizeIdx].name:null,
    holds:holds,addons:addons
  };
  ticket.push(line);
  cust=null;closeModal();renderTicket();
}

/* ---------------- ticket ---------------- */
function ticketSubtotal(){return R(ticket.reduce(function(s,l){return s+R(l.unit*l.qty);},0));}
function ticketTotal(){return R(ticketSubtotal()*(1-discountPct/100));}
function renderTicket(){
  const box=$('#ticket-lines');
  if(!ticket.length){
    box.innerHTML='<p class="ticket-empty">Ticket is empty — tap a menu item to start.</p>';
  }else{
    box.innerHTML=ticket.map(function(l){
      const det=[];
      if(l.size)det.push(esc(l.size));
      (l.holds||[]).forEach(function(h){det.push('No '+esc(h));});
      (l.addons||[]).forEach(function(a){det.push(esc(a.name)+(a.onSide?' (side)':''));});
      return '<div class="tline"><div class="top"><span>'+esc(l.name)+'</span><span>'+M(R(l.unit*l.qty))+'</span></div>'+
      (det.length?'<div class="det">'+det.join(' · ')+'</div>':'')+
      '<div class="row"><div class="qty"><button onclick="lineQty(\''+l.key+'\',-1)">−</button><strong>'+l.qty+'</strong><button onclick="lineQty(\''+l.key+'\',1)">+</button></div>'+
      '<button class="linklike" onclick="lineRemove(\''+l.key+'\')">Remove</button></div></div>';
    }).join('');
  }
  const sub=ticketSubtotal(),tot=ticketTotal(),disc=R(sub-tot);
  ensureRow('#discount-row','#ticket-lines').innerHTML='<span class="lbl">Discount</span>'+
    [0,5,10,15].map(function(p){
      return '<button class="disc-btn'+(discountPct===p?' active':'')+'" onclick="setDiscount('+p+')">'+p+'%</button>';
    }).join('');
  ensureRow('#note-row','#discount-row').innerHTML=ticket.length?
    (ticketNote
      ? '<div class="tnote"><span>'+esc(ticketNote)+'</span><button class="linklike" onclick="editNote()">Edit</button></div>'
      : '<button class="btn note-btn" onclick="editNote()">+ Note</button>')
    :'';
  ensureTenderRow();
  $('#ticket-totals').innerHTML=
    '<div class="r"><span>Subtotal</span><span>'+M(sub)+'</span></div>'+
    (disc>0?'<div class="r"><span>Discount ('+discountPct+'%)</span><span>−'+M(disc)+'</span></div>':'')+
    '<div class="r grand"><span>Total</span><span>'+M(tot)+'</span></div>';
  const tb=document.querySelectorAll('#tender-row .tender');
  if(tb&&tb.forEach)tb.forEach(function(b){b.disabled=!ticket.length;});
}
function lineQty(key,d){
  const l=ticket.find(function(x){return x.key===key;});if(!l)return;
  l.qty+=d;
  if(l.qty<=0)ticket=ticket.filter(function(x){return x.key!==key;});
  renderTicket();
}
function lineRemove(key){ticket=ticket.filter(function(x){return x.key!==key;});renderTicket();}
function setDiscount(p){discountPct=p;renderTicket();}
function editNote(){
  openModal('<h2>Ticket note</h2><div class="sub">Shows on the ticket and saves with the sale. Good for allergies, "no onions", etc.</div>'+
   '<textarea id="note-text" rows="3" style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit" placeholder="Type note\u2026">'+esc(ticketNote)+'</textarea>'+
   '<div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button>'+
   (ticketNote?'<button class="btn" onclick="clearNote()">Clear</button>':'')+
   '<button class="btn primary" onclick="saveNote()">Save note</button></div>');
}
function saveNote(){const t=$('#note-text');ticketNote=t?t.value.trim():'';closeModal();renderTicket();}
function clearNote(){ticketNote='';closeModal();renderTicket();}

/* ---------------- tender ---------------- */
function openTender(type){
  if(!ticket.length)return;
  if(type==='cash'){cashTender={total:ticketTotal(),tendered:0};cashPad='';renderCash();return;}
  const label=({card:'Card',zelle:'Zelle',venmo:'Venmo'})[type]||'Other';
  openModal('<h2>'+label+' payment</h2><div class="sub">Confirm this '+label+' payment to complete the sale.</div>'+
    '<div class="cash-due"><div class="amt">'+M(ticketTotal())+'</div><div class="sub">amount due</div></div>'+
    '<div class="modal-actions"><button class="btn" onclick="closeModal()">Back</button>'+
    '<button class="btn primary" onclick="completeSale(\''+label+'\','+ticketTotal()+',0)">Confirm '+label+' payment</button></div>');
}
function renderCash(){
  const due=cashTender.total,td=cashTender.tendered;
  const change=R(td-due);
  const bills=[5,10,20,50,100].map(function(b){
    return '<button class="btn bill"'+(b<due?' disabled':'')+' onclick="cashBill('+b+')">$'+b+'</button>';
  }).join('');
  const up=Math.ceil(due-1e-9);
  openModal('<h2>Cash payment</h2><div class="sub">Tap the bills the customer hands you.</div>'+
   '<div class="cash-due"><div class="amt">'+M(due)+'</div><div class="sub">amount due</div></div>'+
   '<div class="cash-tendered"><span>Tendered: '+M(td)+'</span></div>'+
   (change>=0?'<div class="change-big"><div class="cb-label">Change due</div><div class="cb-amt">'+M(change)+'</div></div>'
             :'<div class="change-big due"><div class="cb-label">Still due</div><div class="cb-amt">'+M(-change)+'</div></div>')+
   '<div class="bill-grid">'+bills+
   '<button class="btn bill roundup" onclick="cashRoundUp()">Round up · '+M(up)+'</button></div>'+
   '<div style="display:flex;gap:8px;margin-bottom:8px"><button class="btn" style="flex:1" onclick="cashExact()">Exact '+M(due)+'</button>'+
   '<button class="btn" style="flex:1" onclick="cashClear()">Clear</button></div>'+
   '<div class="pad-display">'+M(cashPadVal())+'</div>'+
   '<div class="pad-grid">'+
   ['1','2','3','4','5','6','7','8','9','.','0','bksp'].map(function(k){
     return '<button class="pad-key" onclick="cashPadKey(\''+k+'\')">'+(k==='bksp'?'⌫':k)+'</button>';
   }).join('')+
   '<button class="pad-key fn" onclick="cashPadKey(\'clear\')">C</button>'+
   '<button class="pad-key pad-add" onclick="cashPadAdd()">Add</button></div>'+
   '<div class="modal-actions"><button class="btn" onclick="closeModal()">Back</button>'+
   '<button class="btn primary"'+(td>=due?'':' disabled')+' onclick="completeSale(\'Cash\','+td+','+Math.max(0,change)+')">Complete sale</button></div>');
}
function cashBill(b){cashTender.tendered=R(cashTender.tendered+b);renderCash();}
function cashRoundUp(){cashTender.tendered=Math.ceil(cashTender.total-1e-9);renderCash();}
function cashExact(){cashTender.tendered=cashTender.total;renderCash();}
function cashClear(){cashTender.tendered=0;renderCash();}
function cashPadVal(){
  const v=parseFloat(cashPad);
  return isNaN(v)?0:R(v);
}
function cashPadKey(k){
  if(k==='clear'){cashPad='';}
  else if(k==='bksp'){cashPad=cashPad.slice(0,-1);}
  else if(k==='.'){
    if(!cashPad)cashPad='0.';
    else if(cashPad.indexOf('.')<0&&cashPad.length<7)cashPad+='.';
  }else{ /* digit */
    if(cashPad==='0')cashPad=k;
    else{
      const dot=cashPad.indexOf('.');
      if(cashPad.length<7&&!(dot>=0&&cashPad.length-dot>2))cashPad+=k;
    }
  }
  renderCash();
}
function cashPadAdd(){
  const v=cashPadVal();
  if(v>0)cashTender.tendered=R(cashTender.tendered+v);
  cashPad='';
  renderCash();
}

/* ---------------- complete sale / receipt ---------------- */
async function completeSale(tender,tendered,change){
  const sub=ticketSubtotal(),tot=ticketTotal();
  const sale={
    displayId:'S'+String(sales.length+1).padStart(3,'0'),
    id:null,
    at:new Date(),
    lines:ticket.map(function(l){
      return{itemId:l.itemId,cat:l.cat,name:l.name,qty:l.qty,unit:l.unit,total:R(l.unit*l.qty),
        size:l.size,holds:l.holds||[],addons:l.addons.map(function(a){return{name:a.name,price:a.price,onSide:a.onSide};})};
    }),
    sub:sub,disc:R(sub-tot),total:tot,tender:tender,tendered:R(tendered),change:R(change),note:ticketNote
  };
  /* decrement local stock first — mirrored to Supabase below (or at queue flush) */
  sale.lines.forEach(function(sl){
    const m=MENU.find(function(i){return i.id===sl.itemId;});
    if(m)m.stock=Math.max(0,m.stock-sl.qty);
  });
  const row={vendor_id:state.vendorId,lines:sale.lines,subtotal:sale.sub,discount:sale.disc,
    total:sale.total,tender:sale.tender,tendered:sale.tendered,change:sale.change,note:sale.note};
  let queued=false;
  try{
    const saved=await DB.recordSale(row);
    sale.id=saved&&saved.id;
    for(const sl of sale.lines){
      const m=MENU.find(function(i){return i.id===sl.itemId;});
      if(m){try{await DB.updateItem(m.id,{stock:m.stock});}catch(e){/* best-effort */}}
    }
  }catch(e){
    /* offline: keep selling against the cache; replay on next load */
    state.offline=true;showOfflineBadge();queued=true;
    const q=readQueue();q.push(row);writeQueue(q);
  }
  sales.push(sale);
  ticket=[];discountPct=0;ticketNote='';
  writeCache();renderTicket();renderMenu();
  const rows=sale.lines.map(function(l){
    return '<div class="r" style="display:flex;justify-content:space-between"><span>'+l.qty+' × '+esc(l.name)+'</span><span>'+M(l.total)+'</span></div>';
  }).join('');
  openModal('<h2>Sale complete</h2><div class="sub">'+sale.displayId+' · '+esc(tender)+
   (queued?' · <span class="zero">offline — will sync when reconnected</span>':'')+'</div>'+
   (tender==='Cash'&&change>0?'<div class="change-big"><div class="cb-label">Change due</div><div class="cb-amt">'+M(change)+'</div></div>':'')+
   (sale.note?'<div class="tnote" style="margin-bottom:10px"><span>'+esc(sale.note)+'</span></div>':'')+
   '<div class="receipt">'+rows+
   '<div style="margin-top:6px;border-top:1px solid #e7e5e4;padding-top:6px;display:flex;justify-content:space-between;font-weight:800"><span>Total</span><span>'+M(tot)+'</span></div></div>'+
   '<div class="modal-actions"><button class="btn primary" onclick="closeModal()">New sale</button></div>');
}

/* ---------------- menu admin ---------------- */
function renderMenuAdmin(){
  const list=$('#menu-admin-list');if(!list)return;
  list.innerHTML='<button class="btn primary" style="margin-bottom:10px" onclick="openMenuEdit(null)">+ Add item</button>'+
   MENU.map(function(i){
    return '<div class="admin-row"><div class="ai"><div class="an">'+esc(i.name)+'</div>'+
    '<div class="ad">'+esc(i.cat)+' · '+M(i.price)+' · Stock '+i.stock+'</div></div>'+
    '<label class="switch"><input type="checkbox"'+(i.avail?' checked':'')+' onchange="toggleAvail(\''+i.id+'\')"><span class="tr"></span></label>'+
    '<button class="btn" onclick="openMenuEdit(\''+i.id+'\')">Edit</button></div>';
  }).join('')||'<p class="ticket-empty">No menu items yet.</p>';
}
/* ---- menu editor: options & add-on row builders ---- */
function meOptRowHtml(name,delta){
  return '<div class="ed-row me-opt-row">'+
  '<input class="cname grow" placeholder="Choice name (e.g. Large)" value="'+esc(name||'')+'">'+
  '<input class="cdelta narrow" inputmode="decimal" placeholder="+$0.00" value="'+(delta==null?'':Number(delta).toFixed(2))+'">'+
  '<button class="rm" onclick="this.closest(\'.me-opt-row\').remove()" aria-label="Remove choice">×</button></div>';
}
function meAddOptRow(name,delta){
  $('#me-opt-rows').insertAdjacentHTML('beforeend',meOptRowHtml(name,delta));
}
function meClearOpt(){$('#me-opt-rows').innerHTML='';}
function meAddRowHtml(name,price){
  return '<div class="ed-row me-add-row">'+
  '<input class="aname grow" placeholder="Add-on name (e.g. Extra Cheese)" value="'+esc(name||'')+'">'+
  '<input class="aprice narrow" inputmode="decimal" placeholder="$0.00" value="'+(price==null?'':Number(price).toFixed(2))+'">'+
  '<button class="rm" onclick="this.closest(\'.me-add-row\').remove()" aria-label="Remove add-on">×</button></div>';
}
function meAddAddRow(name,price){
  $('#me-add-rows').insertAdjacentHTML('beforeend',meAddRowHtml(name,price));
}
function openMenuEdit(id){
  const i=id?MENU.find(function(x){return x.id===id;}):null;
  const d=id?(details[id]||{}):{};
  const ings=((d.ingredients)||[]).join('\n');
  const pos=i?i.position:(MENU.reduce(function(mx,x){return Math.max(mx,x.position);},0)+1);
  openModal('<h2>'+(i?'Edit item':'Add item')+'</h2>'+
   '<div class="form-row"><label>Name</label><input id="me-name" value="'+esc(i?i.name:'')+'"></div>'+
   '<div class="form-row"><label>Category</label><input id="me-cat" list="me-catlist" value="'+esc(i?i.cat:'')+'">'+
   '<datalist id="me-catlist">'+vendorCats().slice(1).map(function(c){return '<option value="'+esc(c)+'">';}).join('')+'</datalist></div>'+
   '<div class="form-row"><label>Price</label><input id="me-price" inputmode="decimal" value="'+(i?i.price.toFixed(2):'')+'" placeholder="0.00"></div>'+
   '<div class="form-row"><label>Stock</label><input id="me-stock" inputmode="numeric" value="'+(i?i.stock:'')+'" placeholder="0"></div>'+
   '<div class="form-row"><label>Position</label><input id="me-pos" inputmode="numeric" value="'+pos+'"></div>'+
   '<div class="form-row"><label class="checkline"><input id="me-avail" type="checkbox"'+((!i||i.avail)?' checked':'')+'> Available</label></div>'+
   '<div class="ed-sec"><h4>Hold ingredients (one per line)</h4>'+
   '<textarea id="me-ings" rows="3" style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit" placeholder="Lettuce&#10;Tomato&#10;Onion">'+esc(ings)+'</textarea></div>'+
   '<div class="ed-sec"><h4>Options (sizes / variants)</h4>'+
   '<div class="form-row"><label>Group label</label><input id="me-opt-label" value="'+esc(d.opt?d.opt.label:'Size')+'"></div>'+
   '<div id="me-opt-rows">'+(((d.opt&&d.opt.choices)||[]).map(function(c){return meOptRowHtml(c.name,c.delta);}).join(''))+'</div>'+
   '<div style="display:flex;gap:8px"><button class="btn" style="flex:1" onclick="meAddOptRow()">+ Add choice</button>'+
   (d.opt?'<button class="btn warn" style="flex:1" onclick="meClearOpt()">Remove options</button>':'')+'</div></div>'+
   '<div class="ed-sec"><h4>Add-ons</h4>'+
   '<div id="me-add-rows">'+((d.addons||[]).map(function(a){return meAddRowHtml(a.name,a.price);}).join(''))+'</div>'+
   '<button class="btn" style="width:100%" onclick="meAddAddRow()">+ Add add-on</button></div>'+
   '<div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button>'+
   (i?'<button class="btn warn" onclick="deleteMenuItem(\''+i.id+'\')">Delete</button>':'')+
   '<button class="btn primary" onclick="saveMenuItem('+(i?'\''+i.id+'\'':'null')+')">Save</button></div>');
}
async function saveMenuItem(id){
  const name=($('#me-name').value||'').trim();
  const cat=(($('#me-cat').value||'').trim())||'Uncategorized';
  const price=parseFloat(String($('#me-price').value||'').replace(/[^0-9.]/g,''));
  const stock=parseInt(String($('#me-stock').value||'').replace(/[^0-9]/g,''),10);
  const pos=parseInt(String($('#me-pos').value||'').replace(/[^0-9]/g,''),10);
  if(!name||isNaN(price)||isNaN(stock))return;
  const avail=$('#me-avail').checked;
  const ingredients=String($('#me-ings').value||'').split('\n').map(function(s){return s.trim();}).filter(Boolean);
  const optLabel=(String($('#me-opt-label').value||'').trim())||'Size';
  const choices=[];
  document.querySelectorAll('.me-opt-row').forEach(function(r){
    const nm=String(r.querySelector('.cname').value||'').trim();
    const dl=parseFloat(String(r.querySelector('.cdelta').value||'').replace(/[^0-9.]/g,''));
    if(nm)choices.push({name:nm,delta:isNaN(dl)?0:Math.max(0,R(dl))});
  });
  const addons=[];
  document.querySelectorAll('.me-add-row').forEach(function(r){
    const nm=String(r.querySelector('.aname').value||'').trim();
    const pr=parseFloat(String(r.querySelector('.aprice').value||'').replace(/[^0-9.]/g,''));
    if(nm&&!isNaN(pr))addons.push({name:nm,price:Math.max(0,R(pr))});
  });
  const row={vendor_id:state.vendorId,name:name,category:cat,price:R(price),stock:stock,
    avail:avail,position:isNaN(pos)?0:pos};
  if(id)row.id=id;
  let saved;
  try{saved=await DB.upsertItem(row);}
  catch(e){modalError('Could not save the item. Check your connection and try again.');return;}
  const ix=MENU.findIndex(function(x){return x.id===saved.id;});
  if(ix>=0)MENU[ix]=saved;else MENU.push(saved);
  MENU.sort(function(a,b){return a.position-b.position;});
  const det={};
  if(ingredients.length)det.ingredients=ingredients;
  if(choices.length)det.opt={label:optLabel,choices:choices};
  if(addons.length)det.addons=addons;
  details[saved.id]=det;saveDetails();
  writeCache();closeModal();renderMenuAdmin();renderMenu();
}
async function deleteMenuItem(id){
  try{await DB.deleteItem(id);}
  catch(e){modalError('Could not delete the item. Check your connection and try again.');return;}
  MENU=MENU.filter(function(x){return x.id!==id;});
  delete details[id];saveDetails();
  ticket=ticket.filter(function(l){return l.itemId!==id;});
  writeCache();closeModal();renderMenuAdmin();renderMenu();renderTicket();
}

/* ---------------- reports ---------------- */
function summarize(list){
  const s={gross:0,orders:list.length,qty:0,items:{},addons:{},tenders:{}};
  list.forEach(function(sa){
    s.gross=R(s.gross+sa.total);
    s.tenders[sa.tender]=R((s.tenders[sa.tender]||0)+sa.total);
    (sa.lines||[]).forEach(function(l){
      s.qty+=l.qty;
      const e=s.items[l.itemId]||(s.items[l.itemId]={name:l.name,qty:0,revenue:0});
      e.qty+=l.qty;e.revenue=R(e.revenue+(l.total==null?R(l.unit*l.qty):l.total));
      (l.addons||[]).forEach(function(a){
        const ak=a.name+(a.onSide?' (side)':'');
        const ae=s.addons[ak]||(s.addons[ak]={qty:0,revenue:0});
        ae.qty+=l.qty;ae.revenue=R(ae.revenue+a.price*l.qty);
      });
    });
  });
  s.gross=R(s.gross);
  return s;
}
function card(v,l){return '<div class="card"><div class="cv">'+v+'</div><div class="cl">'+l+'</div></div>';}
function repTable(head,rows){
  return '<table class="rep"><thead><tr>'+head.map(function(h){return '<th>'+h+'</th>';}).join('')+'</tr></thead><tbody>'+
   rows.map(function(r){return '<tr>'+r.map(function(c,i){return '<td class="'+(i>0?'num':'')+'">'+c+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table>';
}
function reportSales(){return viewingClosed>=0?closedDays[viewingClosed].sales:sales;}
function renderReports(){
  const list=reportSales(),s=summarize(list),live=viewingClosed<0;
  let html='';
  if(!live){
    const cd=closedDays[viewingClosed];
    html+='<div class="closed-banner"><strong>Viewing closed day — '+esc(cd.loc||((cd.drawer||{}).loc)||cd.day)+'</strong><button class="btn" onclick="backToLive()">Back to today</button></div>';
    if(cd.drawer){
      html+='<div class="rep-sec"><h3>Cash drawer</h3><div class="drawer-box">'+
       '<div class="dr-row"><span>Opening cash (bank)</span><strong>'+M(cd.drawer.opening)+'</strong></div>'+
       '<div class="dr-row"><span>Cash sales</span><strong>'+M(cd.drawer.cashSales)+'</strong></div>'+
       '<div class="dr-row total"><span>Expected in drawer</span><strong>'+M(cd.drawer.expected)+'</strong></div>'+
       '<div class="dr-row total"><span>Dropped</span><strong>'+M(cd.drawer.drop)+'</strong></div>'+
       '</div></div>';
    }
  }
  html+='<div class="cards">'+card(M(s.gross),'Gross sales')+card(String(s.orders),'Orders')+
    card(s.orders?M(R(s.gross/s.orders)):'$0.00','Avg ticket')+
    card(String(s.qty),'Items sold')+'</div>';
  const items=Object.keys(s.items).map(function(k){return s.items[k];}).sort(function(a,b){return b.revenue-a.revenue;});
  html+='<div class="rep-sec"><h3>Item sales</h3>'+(items.length?repTable(
    ['Item','Qty','Revenue'],
    items.map(function(e){return [esc(e.name),String(e.qty),M(e.revenue)];})
  ):'<p class="zero">No sales yet.</p>')+'</div>';
  const ads=Object.keys(s.addons).map(function(k){return{name:k,qty:s.addons[k].qty,revenue:s.addons[k].revenue};})
    .sort(function(a,b){return b.revenue-a.revenue;});
  if(ads.length)html+='<div class="rep-sec"><h3>Add-on sales</h3>'+repTable(['Add-on','Qty','Revenue'],
    ads.map(function(a){return [esc(a.name),String(a.qty),M(a.revenue)];}))+'</div>';
  const tm=Object.keys(s.tenders);
  if(tm.length)html+='<div class="rep-sec"><h3>Tender mix</h3>'+repTable(['Tender','Total'],
    tm.map(function(k){return [esc(k),M(s.tenders[k])];}))+'</div>';
  html+='<div class="rep-sec"><h3>Stock remaining</h3>'+repTable(['Item','Left'],
    MENU.map(function(i){return [esc(i.name)+(i.avail?'':' <span class="zero">(off)</span>'),String(i.stock)];}))+'</div>';
  const soldIds={};Object.keys(s.items).forEach(function(k){soldIds[k]=1;});
  const zero=MENU.filter(function(i){return !soldIds[i.id];});
  html+='<div class="rep-sec"><h3>Not selling yet</h3>'+(zero.length?'<p>'+zero.map(function(i){return esc(i.name);}).join(', ')+'</p>':'<p class="zero">Everything has sold at least once.</p>')+'</div>';
  html+='<div class="rep-sec"><h3>Recent orders</h3>'+(list.length?repTable(['Order','Items','Tender','Total'],
    list.slice().reverse().slice(0,20).map(function(sa){
      return [esc(sa.displayId||sa.id||''),String((sa.lines||[]).reduce(function(n,l){return n+l.qty;},0)),esc(sa.tender),M(sa.total)];
    })):'<p class="zero">No orders yet.</p>')+'</div>';
  if(live){
    const df=drawerFigures();
    html+='<div class="rep-sec"><h3>Cash drawer</h3>'+
     '<div class="drawer-box">'+
     '<div class="dr-row"><span>Opening cash (bank)</span><strong>'+(drawerOpening>0?M(drawerOpening):'<span class="zero">Not set</span>')+'</strong></div>'+
     '<div class="dr-row"><span>Cash sales so far</span><strong>'+M(df.cashSales)+'</strong></div>'+
     '<div class="dr-row total"><span>Expected in drawer</span><strong>'+M(df.expected)+'</strong></div>'+
     '</div>'+
     '<div class="form-row" style="margin-top:10px"><label>Opening cash — count the drawer at start of day</label><input id="drawer-open" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" value="'+(drawerOpening>0?drawerOpening.toFixed(2):'')+'"></div>'+
     '<button class="btn" onclick="setDrawerOpening()">Set opening cash</button></div>';
    html+='<div class="rep-sec"><h3>End of day</h3><p class="sub" style="margin-bottom:10px">Close and save the day when you finish or move locations. You get the full close-out report — expected cash and what to pull.</p><button class="btn primary big" onclick="openCloseDay()">Close &amp; Save Day</button></div>';
  }
  if(closedDays.length){
    html+='<div class="rep-sec"><h3>Closed days</h3>'+repTable(['Location','Day','Orders','Total',''],
      closedDays.map(function(cd,i){
        const cs=summarize(cd.sales);
        const when=cd.day+(cd.at&&cd.at.toLocaleTimeString?(' '+cd.at.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})):'');
        return [esc(cd.loc||((cd.drawer||{}).loc)||''),esc(when),String(cs.orders),M(cs.gross),'<button class="btn" onclick="viewClosedDay('+i+')">View</button>'];
      }))+'</div>';
  }
  const rb=$('#reports-body');if(rb)rb.innerHTML=html;
}

/* ---------------- cash drawer ---------------- */
function drawerFigures(){
  const s=summarize(sales);
  const cashSales=s.tenders['Cash']||0;
  const expected=R(drawerOpening+cashSales);
  return {opening:drawerOpening,cashSales:cashSales,expected:expected,drop:R(expected-drawerOpening),
    orders:s.orders,gross:s.gross,tenders:s.tenders};
}
async function setDrawerOpening(){
  const el=$('#drawer-open');
  const v=el?parseFloat(el.value):NaN;
  drawerOpening=isNaN(v)||v<0?0:R(v);
  try{await DB.setDrawer(state.vendorId,drawerOpening);}
  catch(e){state.offline=true;showOfflineBadge();}
  renderReports();
}

/* ---------------- close & save day ---------------- */
function openCloseDay(){
  const df=drawerFigures();
  const tn=Object.keys(df.tenders);
  openModal('<h2>Close-out report</h2><div class="sub">'+df.orders+' orders · '+M(df.gross)+' gross</div>'+
   '<div class="drawer-box">'+
   '<div class="dr-row"><span>Opening cash (bank)</span><strong>'+M(df.opening)+'</strong></div>'+
   '<div class="dr-row"><span>+ Cash sales</span><strong>'+M(df.cashSales)+'</strong></div>'+
   '<div class="dr-row total"><span>= Expected in drawer</span><strong>'+M(df.expected)+'</strong></div>'+
   '</div>'+
   '<div class="drop-big"><div class="cb-label">Pull out — leave the bank</div><div class="cb-amt">'+M(df.drop)+'</div></div>'+
   (tn.length?'<div class="glbl" style="margin-top:4px">Tender breakdown</div>'+repTable(['Tender','Total'],tn.map(function(k){return[esc(k),M(df.tenders[k])];})):'')+
   '<div class="form-row"><label>Location</label><input id="cd-loc" value="'+esc(lastLoc)+'"></div>'+
   '<div class="modal-actions"><button class="btn" onclick="closeModal()">Not yet</button>'+
   '<button class="btn primary" onclick="confirmCloseDay()">Close &amp; Save Day</button></div>');
}
async function confirmCloseDay(){
  const loc=String(($('#cd-loc')||{}).value||lastLoc||'Main Stall').trim()||'Main Stall';
  lastLoc=loc;
  const df=drawerFigures();
  const snapshot=JSON.parse(JSON.stringify(sales)); /* plain JSON for the jsonb column */
  const row={vendor_id:state.vendorId,day:localDay(),sales:snapshot,
    drawer:{loc:loc,opening:df.opening,cashSales:df.cashSales,expected:df.expected,drop:df.drop}};
  try{
    await DB.saveClosedDay(row);
    await DB.clearTodaySales(state.vendorId);
  }catch(e){modalError('Could not close the day. Check your connection and try again — nothing was cleared.');return;}
  closedDays.unshift({loc:loc,day:row.day,at:new Date(),sales:sales,drawer:row.drawer});
  sales=[];ticket=[];discountPct=0;ticketNote='';drawerOpening=0;
  viewingClosed=0; /* land on the just-closed day's report */
  try{await DB.setDrawer(state.vendorId,0);}catch(e2){/* best-effort */}
  closeModal();renderTicket();renderMenu();renderReports();
}
function viewClosedDay(i){viewingClosed=i;renderReports();}
function backToLive(){viewingClosed=-1;renderReports();}

/* ---------------- boot ---------------- */
async function init(vendorId){
  state.vendorId=vendorId;state.offline=false;
  wireOnce();
  /* paint the read cache instantly, then refresh from Supabase */
  const cached=readCache();
  if(cached)MENU=cached.menu.map(normalizeItem);
  loadDetails();
  renderAll();renderMenuAdmin();renderReports();
  try{
    MENU=await DB.loadMenu(vendorId);
    writeCache();
    sales=await DB.loadTodaySales(vendorId);
    sales.forEach(function(s,i){s.displayId='S'+String(i+1).padStart(3,'0');});
    closedDays=await DB.loadClosedDays(vendorId);
    const dr=await DB.getDrawer(vendorId);
    drawerOpening=dr?R(Number(dr.opening)||0):0;
    const left=await flushQueue();
    if(left){state.offline=true;showOfflineBadge();}
    else{state.offline=false;hideOfflineBadge();}
    /* reload today's sales so flushed queue items show in the live list */
    sales=await DB.loadTodaySales(vendorId);
    sales.forEach(function(s,i){s.displayId='S'+String(i+1).padStart(3,'0');});
  }catch(e){
    state.offline=true;showOfflineBadge();
  }
  renderAll();renderMenuAdmin();renderReports();
}

/* Reset all in-memory session state on logout so one vendor's in-progress
   ticket can never leak into another vendor's session on a shared device. */
function teardown(){
  ticket=[];discountPct=0;ticketNote='';sales=[];closedDays=[];drawerOpening=0;
  activeCat='All';eightysix=false;viewingClosed=-1;cust=null;
  cashTender={total:0,tendered:0};cashPad='';
  MENU=[];
  closeModal();
  const badge=$('#offline-badge');if(badge&&badge.parentNode)badge.parentNode.removeChild(badge);
  delete _made['#offline-badge'];
  renderAll();renderMenuAdmin();renderReports();
}

window.Register={init:init,renderAll:renderAll,openMenuEdit:openMenuEdit,teardown:teardown};
