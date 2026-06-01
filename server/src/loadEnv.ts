import dotenv from 'dotenv'
import path from 'node:path'

const envPath = path.join(__dirname, '..', '.env')
dotenv.config({ path: envPath, override: true })
