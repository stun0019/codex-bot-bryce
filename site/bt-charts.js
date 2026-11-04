(function(root){
  "use strict";
  const NS="http://www.w3.org/2000/svg";
  const svg=(tag,attributes={})=>{const node=document.createElementNS(NS,tag);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
  const text=(parent,x,y,value,color="#788d9a",size=11)=>{const n=svg("text",{x,y,fill:color,"font-size":size,"font-family":"system-ui"});n.textContent=value;parent.append(n);return n;};
  const money=value=>new Intl.NumberFormat("en-US",{maximumSignificantDigits:8}).format(value);
  function curve(container,points){
    container.replaceChildren();const width=1000,height=210,pad=42,chart=svg("svg",{viewBox:`0 0 ${width} ${height}`,role:"img","aria-label":"獨立訊號累積淨損益曲線"});
    container.append(chart);
    if(!points.length){text(chart,40,100,"尚無已平倉交易，沒有可繪製的累積損益。");return;}
    const values=[0,...points.map(p=>p.value)],low=Math.min(...values),high=Math.max(...values),spread=high-low||1;
    const y=v=>height-pad-(v-low)/spread*(height-2*pad),x=i=>pad+i/Math.max(1,points.length)*(width-2*pad);
    chart.append(svg("line",{x1:pad,y1:y(0),x2:width-pad,y2:y(0),stroke:"#31414a","stroke-dasharray":"4 4"}));
    chart.append(svg("polyline",{points:values.map((v,i)=>`${x(i)},${y(v)}`).join(" "),fill:"none",stroke:points.at(-1).value>=0?"#00bf91":"#e67990","stroke-width":2}));
    text(chart,4,pad,money(high));text(chart,4,height-pad,money(low));text(chart,pad,height-8,"開始");text(chart,width-100,height-8,points.length+" 筆平倉");
  }
  function candles(container,{rows,interval,trade,shift=0},readout){
    container.replaceChildren();const width=1000,height=390,left=22,right=100,top=20,bottom=42;
    if(!rows?.length)return;
    const duration=root.StrategyEngine.INTERVALS[interval];
    const focusAt=trade.openedAt||trade.confirmedAt;
    const anchor=rows.findIndex(row=>row[0]<=focusAt&&row[6]>=focusAt);
    const center=Math.max(0,anchor<0?rows.length-40:anchor),start=Math.max(0,Math.min(rows.length-1,center-30+shift));
    const shown=rows.slice(start,start+80),levels=[trade.entry,trade.stopLoss,trade.target,...(trade.targets||[]).map(t=>t.price)].filter(Number.isFinite);
    let minimum=Math.min(...shown.map(r=>r[3]),...levels),maximum=Math.max(...shown.map(r=>r[2]),...levels);
    const extra=(maximum-minimum||maximum*.01)*.08;minimum-=extra;maximum+=extra;
    const y=v=>top+(maximum-v)/(maximum-minimum)*(height-top-bottom),step=(width-left-right)/shown.length,x=i=>left+(i+.5)*step;
    const chart=svg("svg",{viewBox:`0 0 ${width} ${height}`,role:"img","aria-label":trade.symbol+" "+interval+" 歷史交易圖"});container.append(chart);
    for(let i=0;i<5;i++){const value=minimum+(maximum-minimum)*i/4,at=y(value);chart.append(svg("line",{x1:left,y1:at,x2:width-right,y2:at,stroke:"#15232b"}));text(chart,width-right+8,at+4,money(value));}
    if(trade.strategyVersion){
      const profile=root.SmcEngine.PROFILES[trade.profileId],zone=interval===profile.high?trade.highZone:trade.entryZone;
      for(const [label,z,color]of[["OB",zone,trade.direction==="SHORT"?"#f6465d":"#0ecb81"],["FVG",interval===profile.high?trade.highZone?.fvg:null,"#f0b90b"]])if(z){
        const knownAt=z.createdAt||trade.confirmedAt,index=shown.findIndex(r=>r[6]>=knownAt),begin=index<0?0:Math.max(0,index),leftX=left+begin*step;
        chart.append(svg("rect",{x:leftX,y:y(z.high),width:width-right-leftX,height:Math.max(1,y(z.low)-y(z.high)),fill:color,"fill-opacity":.09,stroke:color,"stroke-opacity":.5}));text(chart,leftX+5,y(z.high)+12,label,color,10);
      }
    }
    shown.forEach((row,i)=>{const color=row[4]>=row[1]?"#00bf91":"#e67990";
      chart.append(svg("line",{x1:x(i),x2:x(i),y1:y(row[2]),y2:y(row[3]),stroke:color}));
      chart.append(svg("rect",{x:x(i)-step*.3,y:Math.min(y(row[1]),y(row[4])),width:step*.6,height:Math.max(1,Math.abs(y(row[1])-y(row[4]))),fill:color}));});
    if(!trade.strategyVersion)for(const[period,color]of(interval==="4h"?[[20,"#e2b864"]]:[[5,"#83bfff"],[10,"#c58bff"],[20,"#e2b864"]])){
      const points=[];for(let i=0;i<shown.length;i++){const index=start+i;if(index<period-1)continue;let sum=0;for(let j=index-period+1;j<=index;j++)sum+=rows[j][4];points.push(`${x(i)},${y(sum/period)}`);}
      chart.append(svg("polyline",{points:points.join(" "),fill:"none",stroke:color,"stroke-width":1.4}));
    }
    const tags=[["進場",trade.entry,"#85bfff"],["停損",trade.stopLoss,"#e67990"],...(trade.targets?trade.targets.map((t,i)=>[t.label,t.price,["#f0b90b","#f8d33a","#ffe69a","#fff2c9"][i]]):[["原目標",trade.target,"#00bf91"]])].filter(([,value])=>Number.isFinite(value)).sort((a,b)=>y(a[1])-y(b[1]));
    const positions=[];
    for(let i=0;i<tags.length;i++)positions[i]=Math.max(y(tags[i][1])-5,i?positions[i-1]+18:top+10);
    for(let i=positions.length-1;i>=0;i--)positions[i]=Math.min(positions[i],i===positions.length-1?height-bottom-5:positions[i+1]-18);
    for(const [index,[label,value,color]]of tags.entries()){
      const at=y(value),labelY=positions[index];
      chart.append(svg("line",{x1:left,x2:width-right,y1:at,y2:at,stroke:color,"stroke-dasharray":"5 4",opacity:.85}));
      chart.append(svg("rect",{x:width-right+3,y:labelY-12,width:right-5,height:16,fill:"#101316"}));text(chart,width-right+7,labelY,label+" "+money(value),color,10);}
    for(const[label,at,color]of[["進",trade.entryBarTime,"#85bfff"],["出",trade.exitBarTime,"#f3d995"]])if(Number.isFinite(at)){
      const index=shown.findIndex(r=>r[0]===Math.floor(at/duration)*duration);if(index>=0){chart.append(svg("line",{x1:x(index),x2:x(index),y1:top,y2:height-bottom,stroke:color,"stroke-dasharray":"3 5",opacity:.5}));text(chart,x(index),top+(label==="進"?11:27),label,color);}}
    for(const target of trade.targets||[])if(target.status==="HIT"&&Number.isFinite(target.barTime)){
      const index=shown.findIndex(r=>r[0]===Math.floor(target.barTime/duration)*duration);
      if(index>=0){const marker=svg("circle",{cx:x(index),cy:y(target.price),r:4,fill:"#f0b90b",stroke:"#352c0c"});
        const title=svg("title");title.textContent=target.label+" 已觸及";marker.append(title);chart.append(marker);}
    }
    for(let i=0;i<shown.length;i+=Math.max(1,Math.floor(shown.length/4))){text(chart,x(i),height-13,new Date(shown[i][0]).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}),"#6d8797",10);}
    const cross=svg("line",{x1:left,x2:left,y1:top,y2:height-bottom,stroke:"#a9bac4",opacity:0});chart.append(cross);
    const show=index=>{const row=shown[index];if(!row)return;cross.setAttribute("x1",x(index));cross.setAttribute("x2",x(index));cross.setAttribute("opacity",.6);
      readout.textContent=new Date(row[0]).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false})+"｜開 "+money(row[1])+" · 高 "+money(row[2])+" · 低 "+money(row[3])+" · 收 "+money(row[4]);};
    chart.addEventListener("pointermove",event=>{const box=chart.getBoundingClientRect(),local=(event.clientX-box.left)/box.width*width;show(Math.max(0,Math.min(shown.length-1,Math.floor((local-left)/step))));});
    show(Math.max(0,Math.min(shown.length-1,center-start)));
  }
  root.BacktestCharts={curve,candles};
})(window);
