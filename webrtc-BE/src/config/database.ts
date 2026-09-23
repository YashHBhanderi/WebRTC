import mongoose from "mongoose";
import * as dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {

    const mogoUrl = process.env.MONGO_URI;    
    if (!mogoUrl) {
        console.error('MongoDB URI is not provided.');
        throw new Error('MongoDB URI is not provided.');
    }
    await mongoose.connect(mogoUrl);
    console.log("Database Connected");

}

export default connectDB;