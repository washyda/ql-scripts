const fs=require("fs");
let s=fs.readFileSync("/d/washy/ql-scripts/_gt_full.mjs","utf8");
s=s.replace("let sj; for(let i=0;i<5;i++){try{sj=await attempt();break;}catch(e){console.log(\"retry\",i,(e as Error).message);await new Promise(r=>setTimeout(r,800));}}","let sj; for(let i=0;i<5;i++){try{sj=await attempt();break;}catch(e){console.log(\"retry\",i,e.message);await new Promise(r=>setTimeout(r,800));}}");
fs.writeFileSync("/d/washy/ql-scripts/_gt_full.mjs",s);
