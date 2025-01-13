import type { OptionalNavigationResource } from 'balena-sdk';
import { getSdk } from 'balena-sdk';
import type { StringValue } from 'ms';
import ms from 'ms';

const apiKey = (process.env.BALENA_API_KEY as unknown as string) ?? undefined;
const apiUrl = (process.env.BALENA_API_URL as unknown as string) ?? undefined;
const deviceUuid =
	(process.env.BALENA_DEVICE_UUID as unknown as string) ?? undefined;

const checkInterval =
	(process.env.HUP_CHECK_INTERVAL as unknown as StringValue) || '1d';

const userTargetVersion =
	(process.env.HUP_TARGET_VERSION as unknown as string) || '';

if (!apiKey) {
	console.error('BALENA_API_KEY required in environment');
	process.exit(1);
}

if (!apiUrl) {
	console.error('BALENA_API_URL required in environment');
	process.exit(1);
}

if (!deviceUuid) {
	console.error('BALENA_DEVICE_UUID required in environment');
	process.exit(1);
}

const balena = getSdk({
	apiUrl,
	dataDirectory: '/tmp/work',
});

const delay = (value: StringValue) => {
	return new Promise((resolve) => setTimeout(resolve, ms(value)));
};

const getExpandedProp = <T extends object, K extends keyof T>(
	obj: OptionalNavigationResource<T>,
	key: K,
) => (Array.isArray(obj) && obj[0] && obj[0][key]) ?? undefined;

const getDeviceType = async (uuid: string): Promise<string> => {
	return await balena.models.device
		.get(uuid, { $expand: { is_of__device_type: { $select: 'slug' } } })
		.then((device) => {
			return getExpandedProp(device.is_of__device_type, 'slug') as string;
		});
};

const getDeviceVersion = async (uuid: string): Promise<string> => {
	return await balena.models.device.get(uuid).then((device) => {
		return balena.models.device.getOsVersion(device);
	});
};

const getTargetVersion = async (
	deviceType: string,
	deviceVersion: string,
): Promise<string | null> => {
	return await balena.models.os
		.getSupportedOsUpdateVersions(deviceType, deviceVersion)
		.then((osUpdateVersions) => {
			if (userTargetVersion === '') {
				console.log(
					'HUP_TARGET_VERSION must be set to perform automatic updates.',
				);
				return null;
			} else {
				if (['recommended', 'latest'].includes(userTargetVersion)) {
					return osUpdateVersions.recommended!;
				} else {
					return (
						(osUpdateVersions.versions.find((version: string) =>
							version.includes(userTargetVersion),
						)!) || null
					);
				}
			}
		});
};

const getUpdateStatus = async (uuid: string): Promise<any> => {
	try {
		const hupStatus = await balena.models.device.getOsUpdateStatus(uuid);
		console.log(hupStatus);
		return hupStatus;
	} catch (e) {
		console.error(`Error getting status: ${e}`);
		return false;
	}
};

const main = async () => {
	while (true) {
		await balena.auth.loginWithToken(apiKey);

		while (!(await balena.models.device.isOnline(deviceUuid))) {
			console.log('Device is offline...');
			await delay('2m');
		}

		console.log('Checking last update status...');
		while (
			await getUpdateStatus(deviceUuid).then((status) => {
				return !status || status.status === 'in_progress';
			})
		) {
			console.log('Another update is already in progress...');
			await delay('2m');
		}

		const deviceType = await getDeviceType(deviceUuid);
		const deviceVersion = await getDeviceVersion(deviceUuid);

		console.log(
			`Getting recommended releases for ${deviceType} at ${deviceVersion}...`,
		);

		const targetVersion = await getTargetVersion(deviceType, deviceVersion);

		if (!targetVersion) {
			console.log(`No releases found!`);
		} else {
			console.log(`Starting balenaOS host update to ${targetVersion}...`);
			await balena.models.device
				.startOsUpdate(deviceUuid, targetVersion)
				.then(async () => {
					while (
						// print progress at regular intervals until status changes
						// or device reboots
						await getUpdateStatus(deviceUuid).then((status) => {
							return !status || status.status === 'in_progress';
						})
					) {
						await delay('10s');
					}
				})
				.catch((e) => {
					console.error(e);
				});
		}

		// both success and failure should wait x before trying/checking again
		console.log(`Will try again in ${checkInterval}...`);
		await delay(checkInterval);
	}
};

console.log('Starting up...');
main().catch((e) => {
  console.error(e);
});
