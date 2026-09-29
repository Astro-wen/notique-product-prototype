/** One mount owns a serial writer. A lost response retries with the exact key,
 * body and version. Edits receive a new key; successful commands can run again. */
export class SubmitSession {
  private tail:Promise<unknown> = Promise.resolve();
  private attempts = new Map<string,{key:string;payload:unknown}>();
  run<T>(endpoint:string, payload:unknown, send:(key:string,body:unknown)=>Promise<T>):Promise<T> {
    const fingerprint = JSON.stringify([endpoint,payload]);
    let attempt = this.attempts.get(fingerprint);
    if (!attempt) {
      attempt={key:crypto.randomUUID(),payload:structuredClone(payload)};
      this.attempts.set(fingerprint,attempt);
    }
    const current = attempt;
    const work=this.tail.then(()=>send(current.key,current.payload)).then(value=>{
      this.attempts.delete(fingerprint);
      return value;
    });
    this.tail=work.catch(()=>undefined);
    return work;
  }
}
