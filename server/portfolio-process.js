import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { AppError } from './store.js';

const MiB=1024*1024,CPU_SHARE=0.15,CPU_BURST_US=20000;
const MEMORY_CEILING=448*MiB;
function linuxResources(){
  const cpu=Number(readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/^usage_usec\s+(\d+)$/m)?.[1]);
  const current=Number(readFileSync('/sys/fs/cgroup/memory.current','utf8').trim());
  const inactive=Number(readFileSync('/sys/fs/cgroup/memory.stat','utf8').match(/^inactive_file\s+(\d+)$/m)?.[1]);
  if(![cpu,current,inactive].every(value=>Number.isSafeInteger(value)&&value>=0)||current<inactive)throw new Error('resource-counters-unavailable');
  return{cpu,workingSet:current-inactive};
}

// Limit only our converter jobs; preserve provider controls and bot responsiveness.
export function createPortfolioProcessRunner({env=process.env,readResources=linuxResources}={}){
  const bounded=env.CONVERTER_RESOURCE_PROFILE==='wisp-free';
  let active=0;
  return async function runPortfolioProcess(command,args,timeoutMs=240000){
    if(bounded&&active)throw new AppError('Já existe um arquivo em processamento. Aguarde a conclusão e tente novamente.',503);
    let previous,at,balance=-CPU_BURST_US;
    if(bounded){
      if(process.platform!=='linux')throw new AppError('O perfil de conversão gratuito requer os limites do servidor Linux.',503);
      try{previous=readResources();at=process.hrtime.bigint();}catch{throw new AppError('Não foi possível verificar os recursos para processar o arquivo.',503);}
      if(previous.workingSet>=MEMORY_CEILING-32*MiB)throw new AppError('O servidor está com pouca memória disponível. Aguarde e tente novamente.',503);
    }
    active++;
    try{return await new Promise((resolveProcess,rejectProcess)=>{
      const childEnv=bounded?{...env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MAGICK_THREAD_LIMIT:'1',MAGICK_MEMORY_LIMIT:'48MiB',MAGICK_MAP_LIMIT:'64MiB',MAGICK_DISK_LIMIT:'32MiB'}:env;
      const child=spawn(command,bounded&&command==='blender'?['--threads','1',...args]:args,{env:childEnv,detached:process.platform==='linux',stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='',failure=null,paused=false,closed=false,monitor;
      let peakWorkingSet=previous?.workingSet||0;
      const append=(current,chunk)=>(current+String(chunk||'')).slice(-12000);
      child.stdout.on('data',chunk=>{stdout=append(stdout,chunk)});
      child.stderr.on('data',chunk=>{stderr=append(stderr,chunk)});
      const signal=name=>{
        try{if(process.platform==='linux')process.kill(-child.pid,name);else child.kill(name);}catch(error){if(error.code!=='ESRCH')throw error;}
      };
      const stop=error=>{
        if(closed||failure)return;
        failure=error;
        // Output is unique and unpublished. Kill this group before exhausting RAM.
        try{signal('SIGKILL')}catch{}
      };
      const timer=setTimeout(()=>stop(new AppError('O processamento do arquivo excedeu o tempo limite.',504)),timeoutMs);
      if(bounded)monitor=setInterval(()=>{
        if(failure||closed)return;
        try{
          const usage=readResources(),now=process.hrtime.bigint();
          if(usage.cpu<previous.cpu)throw new Error('cpu-counter-reset');
          peakWorkingSet=Math.max(peakWorkingSet,usage.workingSet);
          if(usage.workingSet>=MEMORY_CEILING)return stop(new AppError('Este arquivo excede a memória disponível para conversão. Envie uma versão menor ou já convertida.',422));
          balance=Math.max(-CPU_BURST_US,balance+usage.cpu-previous.cpu-Number(now-at)/1000*CPU_SHARE);
          previous=usage;at=now;
          const mustPause=balance>0;
          if(mustPause!==paused){signal(mustPause?'SIGSTOP':'SIGCONT');paused=mustPause;}
        }catch{stop(new AppError('A verificação de recursos foi interrompida. Tente processar o arquivo novamente.',503));}
      },100);
      const cleanup=()=>{closed=true;clearTimeout(timer);if(monitor)clearInterval(monitor);};
      child.once('error',error=>{
        cleanup();rejectProcess(new AppError(`Não foi possível iniciar o processador: ${error.message}`,503));
      });
      child.once('close',code=>{
        if(closed)return;
        cleanup();
        if(failure)return rejectProcess(failure);
        if(code===0)return resolveProcess({stdout,stderr,...(bounded?{resources:{peakWorkingSetBytes:peakWorkingSet,cpuShareTarget:CPU_SHARE}}:{})});
        rejectProcess(new AppError((stderr||stdout||`Processador finalizou com código ${code}`).slice(-1500),422));
      });
    });}finally{active--;}
  };
}
