<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Project Legitimacy

This page states GripEventsCtl's posture in one place.
It covers what the tool is, who runs the platform it talks to, and what that platform's terms say.
It also covers how the project treats other people's data and what the project will not do.
It discloses facts. It does not argue a legal case, and it is not legal advice.

Every platform fact below was read on 2026-10-12, unless the text gives another date.
Security and abuse reports go through [SECURITY.md](../SECURITY.md).

## 1. What GripEventsCtl is

GripEventsCtl is a command-line tool and a local MCP server for event apps hosted on Grip.
Grip is the event-networking platform at grip.events.
GripEventsCtl is unofficial.
The company that runs Grip does not make, endorse or support it.

You sign in with your own attendee account for one event.
You run the sign-in command yourself, in a terminal.
An AI assistant never receives your password.

After sign-in, GripEventsCtl reads what your attendee account can already see in the event app:

- the attendee directory;
- the profile of each person in it;
- your own matches, chats, meetings and schedule.

It writes only three things, and each one is an action you take as yourself:

- show interest in a person, with an optional message;
- skip a person;
- send a chat message.

GripEventsCtl runs on your own computer.
It has no server and no hosted version.
Its MCP server talks to your AI assistant over stdio only.

## 2. Who runs Grip

Grip is a trading name of Intros.at Ltd.

| Fact                   | Value                                                                                                                | Source, read 2026-10-12                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal name             | Intros.at Ltd ("INTROS.AT LIMITED" at Companies House), trading as Grip                                              | [Grip End User License Agreement](https://www.grip.events/utility-pages/end-user-license-agreement), [Companies House](https://find-and-update.company-information.service.gov.uk/company/09343609) |
| Registration           | England and Wales, company number 09343609, active, incorporated 5 December 2014                                     | [Companies House](https://find-and-update.company-information.service.gov.uk/company/09343609)                                                                                                      |
| Registered office      | 2 Leman Street, London, United Kingdom, E1W 9US                                                                      | [Companies House](https://find-and-update.company-information.service.gov.uk/company/09343609)                                                                                                      |
| Address in site footer | Runway East London Bridge, Office 2.6, 18 Crucifix Ln, London, SE1 3JW                                               | [grip.events](https://www.grip.events/)                                                                                                                                                             |
| United States entity   | Grip Technologies LLC, registered office c/o The Corporation Trust Company, 1209 Orange Street, Wilmington, DE 19801 | [Grip US privacy policy](https://www.grip.events/utility-pages/privacy-policy-us)                                                                                                                   |

## 3. The name "Grip"

"Grip" is the platform's name, and it belongs to its owner.
GripEventsCtl uses the word only to say which platform your session belongs to.
This is nominative use.
The platform cannot be named without the word.
The project uses the plain word and nothing more.
Nothing in the project suggests sponsorship or endorsement.
GripEventsCtl uses no Grip logo, colours or design assets.

Whether "Grip" is a registered trade mark, and in whose name, is not verified on 2026-10-12.
The UK Intellectual Property Office search answered with a bot challenge.
The EUIPO register was not checked.

## 4. What Grip's terms for attendees say

Grip's terms for attendees are its
[End User License Agreement](https://www.grip.events/utility-pages/end-user-license-agreement).
The agreement is between the attendee and Intros.at Ltd.
It says it "applies to you personally as an end user of the platform."
The page shows no effective date.

These are the clauses that touch automated access, scraping and account sharing.
Each quote is the clause text as published on 2026-10-12.

Definitions, clause 1.1:

> Agentic Tool: any automated agent, AI-powered workflow, large language model integration, or autonomous software process that interacts with the platform on behalf of a user or third party without real-time human input for each individual action.

> Scraping: any automated or systematic extraction, collection, copying, monitoring or republication of data, content or information from the platform, whether by technical or other means.

Licence, clause 2.1:

> Subject to your compliance with this Agreement, Intros grants you a limited, non-exclusive, non-transferable, revocable licence to access and use the platform solely for the purpose of attending and participating in the Event.

Account sharing, clause 3.2:

> You must not share your access credentials with any third party or permit any other person or automated process to access the platform using your credentials.

Scraping and automated access, clause 4.2:

> You must not conduct, facilitate, authorise or permit any Scraping of the platform. This prohibition applies regardless of the purpose of the Scraping and includes using (or permitting, authorising or attempting the use of):
>
> (a) any robot, bot, spider, crawler, scraper or other automated device, program, tool, algorithm, code, process or methodology to access, obtain, copy, monitor or republish any portion of the platform or any data, content, information or services accessible via the platform;
>
> (b) any Agentic Tool to interact with, query or extract data from the platform without Intros’ prior written consent;
>
> [...]
>
> (d) any technique designed to circumvent technical measures implemented by Intros to prevent or restrict automated access.

Use of other attendees' data, clause 4.4:

> You must not use any data obtained from the platform (including other users’ profile information, meeting data or contact details) for any purpose other than your own participation in the Event, including building, compiling or augmenting any external database, contact list, mailing list or lead generation resource.

System integrity, clause 4.8, items (e) and (g), and clause 4.9:

> (e) reverse engineer, decompile, disassemble or otherwise attempt to derive the source code, underlying algorithms or data structures of the platform or any part of it;

> (g) make excessive automated requests to the platform or otherwise impose an unreasonable load on Intros' infrastructure.

> 4.9 Conduct falling within clause 4.8 may constitute a criminal offence under the Computer Misuse Act 1990. Intros will report credible evidence of such conduct to the relevant law enforcement authorities and will cooperate with any resulting investigation.

Enforcement, clause 8.1, item (d):

> (d) throttle, rate-limit or block automated or excessive requests from your account or associated IP addresses;

Grip's terms with event organisers say the same thing from the organiser's side.
Clause 9.5 of the
[Grip Terms & Conditions May 2026](https://www.grip.events/utility-pages/terms-conditions-may-2026)
binds the organiser to "use reasonable endeavours to ensure that End Users do not" scrape the platform.

### The project's reading

- GripEventsCtl is a program that reaches the platform with your credentials.
  Clause 3.2 forbids letting an "automated process" use your credentials.
- Clause 4.2(a) forbids any "program, tool" used to "access, obtain, copy" any part of the platform.
- Neither clause has an exception for personal use or a route to consent.
- GripEventsCtl's MCP server lets an AI assistant query the platform for you.
  That fits the clause 1.1 definition of an Agentic Tool.
  Clause 4.2(b) forbids it "without Intros’ prior written consent".
- So, as written on 2026-10-12, Grip's terms prohibit using GripEventsCtl with a Grip account.
  Using it only for yourself, through your own session, does not change that.
- The API notes under `docs/api/` were written by reading the web app's JavaScript and by running the calls the app runs.
  Clause 4.8(e) names deriving the platform's "underlying algorithms or data structures" as reverse engineering, and clause 4.9 says such conduct may be a criminal offence under the Computer Misuse Act 1990.
- You are the party to these terms, not the project.
  Under clause 8, Intros can warn you, limit features, throttle requests, or suspend or end your access.
- The project cannot give you Intros' consent.
  Read the agreement for your event's app before you sign in with GripEventsCtl.

## 5. How the tool stays close to what you do by hand

These design choices do not make the use permitted.
They keep each action one you could take yourself in the app.

- It reads only what your own attendee account already sees.
- It holds one account for one event at a time.
- It writes only the three actions in section 1, each as yourself.
- Writes are off by default. You turn them on in the config file.
- Each write is guarded against a repeat to the same person.
- Each write is logged in an append-only send log.
- It never sends a message your assistant wrote unless your go-ahead is recorded first.
- It honours Grip's own throttling of interest and chat writes, and does not evade it.

## 6. Platform changes the project respects

On 2026-10-07, the maintainer read Grip's public roadmap.
It listed "Automatic Blocking of Attendee List Scraping" with the timeframe "Now".
The expected release was Q4 2026, for the Grip Engage platform.
When Grip blocks automated reads of the attendee list, GripEventsCtl will not work around the block.
A feature that Grip blocks stays blocked.
This also follows clause 4.2(d) above.

## 7. Other people's data

The maintainer made this decision, recorded here on 2026-10-12.

- The attendee directory is personal data of other people.
- GripEventsCtl shows it only to you, and you could already see it in the app.
- GripEventsCtl writes no attendee data to disk unless you ask for an export.
  The one exception is the record of your own writes.
- You are responsible for what you keep, and for how long you keep it.
  The tool's documentation says so.
- Bulk export for lead lists, resale, enrichment, or contact outside the platform is out of scope.
  The project names it as misuse.
- Interest and chat writes are capped by Grip's own throttling.
  The tool honours that throttling rather than evading it.

## 8. Not a competing service

GripEventsCtl is licensed under [AGPL-3.0-only](../LICENSE).
Anyone who runs a changed version as a network service must offer its source to that service's users.
That makes a closed hosted copy impractical.
The project has no hosted version, no managed tier, and no plan to run GripEventsCtl for other people.

Grip offers its own [MCP product](https://discover.grip.events/product-mcp), aimed at event organisers.
GripEventsCtl has no connection to it.

## 9. What the project will not do

The limits on this page are a contribution policy.
Pull requests that cross them will be declined, however clean the code:

- **No bulk export.** No features for lead lists, resale, enrichment, or contact outside the platform.
- **No acting for others.** No shared accounts, no second attendee, and no service that runs many accounts.
- **No circumvention.** No way around Grip's throttling, scraping blocks, or other technical measures.
- **No removal of the write guards.** Off by default, repeat guard, append-only send log, and recorded go-ahead all stay.
- **No AI training.** No feature that feeds platform data into training or tuning a model.
- **No network listener.** The MCP server speaks stdio only.

## 10. Contact

Report misuse of GripEventsCtl through
[SECURITY.md § Abuse reporting](../SECURITY.md#abuse-reporting).
Report a security flaw through
[SECURITY.md § Reporting a vulnerability](../SECURITY.md#reporting-a-vulnerability).
If you speak for Intros.at Ltd and want the project to change, use the same email address.
The maintainer reads every report.
Reports without your real name are welcome.
