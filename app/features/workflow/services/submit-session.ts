/** One mount owns a serial writer. A lost response retries with the exact key,
 * body and version. Edits receive a new key; successful commands can run again. */
export class SubmitSession {
  private tail:Promise<unknown> = Promise.resolve();
  private pending = new Set<Promise<unknown>>();
  private attempts = new Map<string,{key:string;payload:unknown}>();
  private attempt(endpoint:string,payload:unknown) {
    const fingerprint = JSON.stringify([endpoint,payload]);
    let attempt = this.attempts.get(fingerprint);
    if (!attempt) {
      attempt={key:crypto.randomUUID(),payload:structuredClone(payload)};
      this.attempts.set(fingerprint,attempt);
    }
    return {fingerprint,current:attempt};
  }
  private async dispatch<T>(attempt:ReturnType<SubmitSession['attempt']>,send:(key:string,body:unknown)=>Promise<T>) {
    const value=await send(attempt.current.key,attempt.current.payload);
    this.attempts.delete(attempt.fingerprint);
    return value;
  }
  private enqueue<T>(send:()=>Promise<T>):Promise<T> {
    const work=this.tail.then(send);
    this.pending.add(work);
    void work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));
    this.tail=work.catch(()=>undefined);
    return work;
  }
  run<T>(endpoint:string, payload:unknown, send:(key:string,body:unknown)=>Promise<T>):Promise<T> {
    const attempt=this.attempt(endpoint,payload);
    return this.enqueue(()=>this.dispatch(attempt,send));
  }
  /** Resolve the report version only after submitted saves and their refreshes.
   * A failed save stops this copy; aborting drops a queued read, not the save. */
  runLatest<T>(endpoint:string,prepare:()=>unknown,send:(key:string,body:unknown)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    if(signal?.aborted)return Promise.reject(signal.reason);
    const preceding=[...this.pending];
    const work=this.enqueue(async()=>{
      signal?.throwIfAborted();
      await Promise.all(preceding);
      signal?.throwIfAborted();
      return this.dispatch(this.attempt(endpoint,prepare()),send);
    });
    if(!signal)return work;
    return new Promise<T>((resolve,reject)=>{
      const abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      work.then(value=>{
        signal.removeEventListener('abort',abort);resolve(value);
      },error=>{
        signal.removeEventListener('abort',abort);reject(error);
      });
    });
  }
}
