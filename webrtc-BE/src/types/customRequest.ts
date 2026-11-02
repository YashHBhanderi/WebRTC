import { Request } from "express";
import { RequestContext } from "../tenancy/context";


interface CustomRequest extends Request {
    userId?: string;
    /** Trusted workspace context (set by verifyToken from the verified session) */
    ctx?: RequestContext;
    
}

export default CustomRequest;
