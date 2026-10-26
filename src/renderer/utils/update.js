import { httpGet } from './request'

// 版本更新源：siruoren/lx-music-desktop 仓库的 GitHub Releases 最新版本
const releasesApiUrl = 'https://api.github.com/repos/siruoren/lx-music-desktop/releases'

const request = async(url, retryNum = 0) => {
  return new Promise((resolve, reject) => {
    httpGet(url, {
      timeout: 10000,
    }, (err, resp, body) => {
      if (err || resp.statusCode != 200) {
        ++retryNum >= 3
          ? reject(err || new Error(resp.statusMessage || resp.statusCode))
          : request(url, retryNum).then(resolve).catch(reject)
      } else resolve(body)
    })
  })
}

const formatVersion = version => version.replace(/^v/i, '')

const getReleaseInfo = async() => {
  return request(releasesApiUrl).then(list => {
    if (!Array.isArray(list)) throw new Error('failed')
    const releases = list.filter(item => !item.draft && !item.prerelease && item.tag_name != null)
    if (!releases.length) throw new Error('failed')
    const latest = releases[0]
    return {
      version: formatVersion(latest.tag_name),
      desc: latest.body || '',
      history: releases.slice(1).map(item => ({
        version: formatVersion(item.tag_name),
        desc: item.body || '',
      })),
    }
  })
}

export const getVersionInfo = async() => {
  return getReleaseInfo()
}
