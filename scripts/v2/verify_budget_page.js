const fs=require('fs');
const html=fs.readFileSync('budget.html','utf8');
const js=html.match(/<script>([\s\S]*)<\/script>/)[1];
const data=JSON.parse(fs.readFileSync('budget.json','utf8'));
const ids=[...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(m=>m[1]);
const nodes={};
ids.forEach(i=>{nodes[i]={innerHTML:'',textContent:'',value:'',className:'',hidden:false,
  addEventListener(){}, getContext(){return new Proxy({},{get:()=>()=>undefined})}, width:1120,height:260};});
const set=(id,v)=>{ if(nodes[id]) nodes[id].value=v; };
set('iMode','hold'); set('iGrow','5'); set('iStep','20'); set('iReact','1.5'); set('iGoal','1.5');
global.document={getElementById:i=>nodes[i]||{innerHTML:'',textContent:'',value:'',className:'',
  hidden:false,addEventListener(){},style:{},getContext(){return new Proxy({},{get:()=>()=>undefined})}}};
const body=js.replace(/fetch\('budget\.json[\s\S]*$/,'');
try{
  new Function('DATA', body+'\n S=DATA; render();')(data);
  console.log('render() ran clean\n');
  const show=(k,id)=>console.log(('  '+k).padEnd(11)+':',(nodes[id].textContent||nodes[id].innerHTML).replace(/<[^>]*>/g,' ').trim().slice(0,86));
  show('plan',   'planTxt'); show('amount','planAmt'); show('goal','goalH');
  show('step 1','s1H'); show('step 3','s3H'); show('wave 2','s5H'); show('grow','growH');
}catch(e){ console.log('RUNTIME ERROR:',e.message); process.exit(1); }
