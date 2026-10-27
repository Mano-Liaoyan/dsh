/** Seed disposable durable storage and verify effects independently from the tool result. */
import { readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const inject = ['sessionPersistence', 'tools', 'agents', 'agentLoop']

export async function apply(ctx) {
  const target = 'snapshot-delete-target'
  const writer = await ctx.sessionPersistence.create({
    id: target,
    version: 4,
    createdAt: 1,
    cwd: process.cwd(),
    isSeeded: false,
    delegationDepth: 0,
  })
  try {
    await writer.flush()
  } finally {
    await writer.close()
  }
  const original = await ctx.sessionPersistence.stat(target)
  if (original?.location === undefined) throw new Error('Disposable JSONL session did not materialize')
  const targetDir = dirname(original.location.path)
  await ctx.agents.resume({ resumeSessionId: target })
  if (ctx.agents.get(target) === undefined) throw new Error('Disposable session did not become loaded')
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name !== 'session_delete') return decision
    const deleted = await ctx.sessionPersistence.stat(target)
    const current = await ctx.sessionPersistence.stat(exec.agent.session.id)
    if (deleted !== undefined || current?.location === undefined || ctx.agents.get(target) !== undefined) {
      throw new Error('Loaded Session deletion storage verification failed')
    }
    const remaining = await readdir(targetDir)
    if (remaining.some(name => name.includes('.jsonl'))) throw new Error('Disposable Session generations remain on disk')
    if (!(await stat(current.location.path)).isFile()) throw new Error('Current Session log is missing')
    await writeFile(join(process.cwd(), 'deletion-verified.txt'), 'Disposable session removed; current session retained.\n')
    return decision
  })
}
