import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateStrongPassword } from '@motif/core'
import type { MotifStore } from '@motif/db'
import { hashPassword } from './auth'

/** 凭据文件名（位于 dataDir 下，已被 .gitignore 的 .data/ 规则覆盖） */
export const ADMIN_CREDENTIALS_FILE = 'admin-credentials.txt'

const DEFAULT_ADMIN_EMAIL = 'admin@motif.local'

export interface BootstrapDeps {
  store: MotifStore
  dataDir: string
  env: NodeJS.ProcessEnv
}

export interface BootstrapResult {
  created: boolean
  email: string
  /** 仅在本次创建时返回；已存在或跳过时为 null */
  password: string | null
  /** 凭据文件是否成功交付：账号已建但文件写失败时为 false（需人工介入） */
  credentialsWritten: boolean
}

/**
 * 部署引导：库中尚无超级管理员时创建第一个 root，并交付随机强密码。
 *
 * 幂等依据是「库中是否已存在 role='root'」，不是凭据文件是否存在 ——
 * 因此重复启动不会重建账号，也不会覆盖用户已改过的密码。
 * 仅在创建那一刻写凭据文件；任何异常只记录日志，不阻断进程启动。
 */
export function ensureRootAccount(deps: BootstrapDeps): BootstrapResult {
  const email = deps.env.MOTIF_ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL
  try {
    if (deps.env.MOTIF_SKIP_ADMIN_BOOTSTRAP === '1') {
      return { created: false, email, password: null, credentialsWritten: false }
    }
    if (deps.store.countUsersByRole('root') > 0) {
      return { created: false, email, password: null, credentialsWritten: false }
    }
    const fromEnv = deps.env.MOTIF_ADMIN_PASSWORD
    const password = fromEnv && fromEnv.length > 0 ? fromEnv : generateStrongPassword()
    deps.store.createUser({
      email,
      passwordHash: hashPassword(password),
      name: '超级管理员',
      role: 'root',
      credits: 0,
      mustChangePassword: true,
    })

    // 账号已建成。凭据交付失败不应影响 created 的语义，单独降级为 credentialsWritten=false
    let credentialsWritten = false
    try {
      writeCredentialsFile(deps.dataDir, email, password)
      credentialsWritten = true
    } catch (e) {
      console.error('[motif] 凭据文件写入失败（账号已创建，请用 pnpm admin:reset 重新签发）:', e)
    }
    logCredentials(email, password, credentialsWritten)
    return { created: true, email, password, credentialsWritten }
  } catch (e) {
    console.error('[motif] 管理员引导失败（不影响进程启动，可用 pnpm admin:reset 补建或重置）:', e)
    return { created: false, email, password: null, credentialsWritten: false }
  }
}

function writeCredentialsFile(dataDir: string, email: string, password: string): void {
  // dataDir 在全新部署（尤其 MOTIF_DATA_DIR 指向尚未创建的路径）下可能不存在
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, ADMIN_CREDENTIALS_FILE)
  writeFileSync(
    file,
    `Motif 超级管理员凭据\n邮箱: ${email}\n密码: ${password}\n生成时间: ${new Date().toISOString()}\n\n请登录后立即修改密码；本文件仅包含密码明文，勿提交到版本库。\n`,
    { mode: 0o600 }
  )
  // writeFileSync 的 mode 只在新建文件时生效，显式再收一次权限
  chmodSync(file, 0o600)
}

function logCredentials(email: string, password: string, fileOk: boolean): void {
  const line = '='.repeat(64)
  console.log(
    `\n${line}\n[motif] 已自动创建超级管理员账号\n  邮箱: ${email}\n  密码: ${password}\n  请登录后立即修改密码${
      fileOk ? '' : '（凭据文件写入失败，请立即记录本密码）'
    }\n${line}\n`
  )
}
