/** datetime-local inputs require local wall time, not an ISO UTC prefix. */
export function localDateInput(value:Date=new Date()):string {
  const pad=(n:number)=>String(n).padStart(2,'0');
  return `${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
