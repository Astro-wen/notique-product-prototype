import {getBindings,getD1} from '@/db';
import {handleMcpRequest} from '@/lib/server/mcp/server';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleMcpRequest(request,getD1(),getBindings());}
export async function GET(){return new Response(null,{status:405,headers:{Allow:'POST'}});}
export const DELETE=GET;
