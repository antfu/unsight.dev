import type { Installation, InstallationLite, WebhookEvent } from '@octokit/webhooks-types'
import type { H3Event } from 'h3'
import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

import { indexIssue, removeIssue, storagePrefixForRepo } from '../../utils/embeddings'

export default defineEventHandler(async (event) => {
  const isValidWebhook = await isValidGithubWebhook(event)

  if (!isValidWebhook) {
    throw createError({ statusCode: 401, message: 'Unauthorized: webhook is not valid' })
  }

  const body = await readBody<WebhookEvent>(event)
  const promises: Promise<unknown>[] = []
  if ('action' in body && 'installation' in body && !('client_payload' in body)) {
    if ('repository' in body && body.installation && body.repository) {
      const repoMetadata = await hubKV().getItem<RepoMetadata>(`repo:${body.repository.owner.login}:${body.repository.name}`)
      if (repoMetadata && !repoMetadata.indexed) {
        promises.push(addRepos(event, body.installation, [body.repository]))
      }
    }
    if (body.action === 'created' && 'repositories' in body) {
      promises.push(addRepos(event, body.installation, body.repositories || []))
    }
    if (body.action === 'deleted' && 'repositories' in body) {
      for (const repo of body.repositories || []) {
        promises.push(deleteRepo(event, repo))
      }
    }
    if ((body.action === 'added' || body.action === 'removed')) {
      if ('repositories_added' in body) {
        promises.push(addRepos(event, body.installation, body.repositories_added))
      }
      if ('repositories_removed' in body) {
        for (const repo of body.repositories_removed) {
          promises.push(deleteRepo(event, repo))
        }
      }
    }
    if (body.action === 'publicized' && body.installation) {
      promises.push(addRepos(event, body.installation, [body.repository]))
    }
    if (body.action === 'privatized') {
      promises.push(deleteRepo(event, body.repository))
    }
  }

  if ('issue' in body) {
    switch (body.action) {
      case 'created':
      case 'edited':
      case 'opened':
      case 'reopened':
        promises.push(indexIssue(body.issue, body.repository))
        break

      case 'closed':
      case 'deleted':
        promises.push(removeIssue(body.issue, body.repository))
        break
    }
  }

  event.waitUntil(Promise.allSettled(promises))

  return null
})

export type InstallationRepo = {
  id: number
  node_id: string
  name: string
  full_name: string
  private: boolean
}

type RepoMetadata = InstallationRepo & {
  indexed: boolean
}

async function addRepos(event: H3Event, installation: Installation | InstallationLite, repos: InstallationRepo[]) {
  const config = useRuntimeConfig(event)
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      installationId: installation.id,
    },
  })

  const kv = hubKV()

  event.waitUntil(Promise.all(repos.map((repo) => {
    if (repo.private) {
      return
    }

    const [owner, name] = repo.full_name.split('/')
    return kv.setItem(`repo:${owner}:${name}`, { ...repo, indexed: false } satisfies RepoMetadata)
  })))

  for (const repo of repos) {
    if (repo.private) {
      continue
    }

    console.log('starting to index', `${repo.full_name}`)

    const [owner, name] = repo.full_name.split('/')

    const promises: Array<Promise<unknown>> = []

    await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner: owner!,
      repo: name!,
      state: 'open',
      per_page: 100,
    }, (response) => {
      console.log(response.headers)
      for (const issue of response.data) {
        promises.push(indexIssue(issue, { owner: { login: owner! }, name: name! }))
      }
      return []
    })

    await Promise.allSettled(promises).then((r) => {
      if (r.some(p => p.status === 'rejected')) {
        console.error('Failed to fetch some issues from', `${owner}/${name}`)
      }
    })

    console.log('added', promises.length - 1, 'issues from', `${owner}/${name}`, 'to the index')

    event.waitUntil(kv.setItem(`repo:${owner}:${name}`, { ...repo, indexed: true } satisfies RepoMetadata))
  }
}

async function deleteRepo(event: H3Event, repo: InstallationRepo) {
  const [owner, name] = repo.full_name.split('/')
  const kv = hubKV()

  event.waitUntil(kv.removeItem(`repo:${owner}:${name}`))

  const keys = await kv.getKeys(storagePrefixForRepo(owner!, name!))
  await Promise.allSettled(keys.map(async key => kv.removeItem(key))).then((r) => {
    if (r.some(p => p.status === 'rejected')) {
      console.error('Failed to remove some issues from', `${owner}/${name}`)
    }
  })

  console.log('removed', keys.length, 'issues from', `${owner}/${name}`, 'to the index')
}
