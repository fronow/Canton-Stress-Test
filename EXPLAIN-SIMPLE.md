# What we built — explained simply

*(English first, Bulgarian below — Български превод по-долу)*

---

## 🇬🇧 English

### Imagine a bank made of Lego

Canton is a way for banks to build things that move money. Think of it like a
very serious set of Lego bricks. People snap the bricks together and build a
machine — one that sends money from Alice to Bob.

When you build a machine, you want to know one thing before you let real people
use it:

> **How fast can it go before it starts breaking?**

A toy car is fine on the carpet. But what happens on a real road, with a hundred
other cars? Nobody knew. There was no way to find out.

### So we built a machine-tester

We built a tool that **pushes** the machine. Hard.

It pretends to be lots of people all using the app at once — hundreds of them,
all sending money at the same time — and it watches very carefully what happens.

Then it tells you three things:

**1. How fast?**
"Your machine can do 15 payments every second."

**2. When does it hurt?**
Not just "it's slow" — but *how* slow for the unluckiest person. If 99 out of
100 people wait less than a second, that's the number that matters. Averages
lie: they hide the person who waited ten seconds.

**3. What broke — and which brick was it?**
This is the clever part.

Imagine a hundred children all reaching for the **same** Lego brick at once.
Only one child gets it. The other ninety-nine go home empty-handed.

Our tool doesn't just say "lots of children failed". It points at the exact
brick and says: **"this one. This is the brick everyone is fighting over."**

That's the difference between "something is wrong" and "here is the thing to
fix".

### Did it actually find anything?

Yes — and this is the best part.

We tested somebody else's machine. Real code, written by a well-known company
(OpenZeppelin), not by us.

Everyone assumed the slow part was the big central brick — the "factory" that
every payment goes through. It looked obvious: everyone touches it.

**It wasn't.** The factory was fine. It never fought with anybody.

The real fight was over the **coins**. Every payment has to pick a coin to
spend. When two payments grab the same coin at the same time, one of them loses
— because the coin is already gone.

So the answer wasn't "make the factory faster". It was **"be smarter about
which coin you pick"**. Nobody knew that before. Their own tests couldn't have
found it, because their tests check whether it works — not what happens when a
hundred people do it at once.

### One more thing we measured

To use the machine, you have to carry a little sealed envelope with you every
time — proof that you're allowed. It's small, about half a page of writing.

We measured what carrying that envelope costs.

The answer: for most people, nothing. But for the unluckiest ones, it makes the
wait **45% longer**. Nobody had ever measured this. Now it's written down.

### Why does any of this matter?

Because banks sign contracts that say *"this will be fast"*. If it isn't, that's
not embarrassing — that's a broken promise with lawyers attached.

Before us, teams found out how fast their machine was **after** launching it.

Now they can find out first.

---

## 🇧🇬 Български

### Представи си банка, направена от Лего

Canton е начин банките да си строят машини, които движат пари. Представи си го
като много сериозен комплект Лего. Хората сглобяват блокчетата и правят машина —
такава, която праща пари от Алиса до Боб.

Когато построиш машина, искаш да знаеш едно нещо, преди да пуснеш истински хора
да я използват:

> **Колко бързо може да работи, преди да започне да се чупи?**

Играчка-кола е чудесна на килима. Но какво става на истински път, със сто други
коли? Никой не знаеше. Нямаше начин да се разбере.

### Затова построихме изпитвач на машини

Направихме инструмент, който **натиска** машината. Силно.

Той се преструва на много хора, които използват приложението едновременно —
стотици, всички пращат пари в един и същи момент — и много внимателно
наблюдава какво се случва.

После ти казва три неща:

**1. Колко бързо?**
„Твоята машина може да прави по 15 плащания всяка секунда."

**2. Кога започва да боли?**
Не просто „бавно е", а *колко* бавно за най-нещастния човек. Ако 99 от 100 души
чакат по-малко от секунда — това е числото, което има значение. Средните
стойности лъжат: те скриват човека, който е чакал десет секунди.

**3. Какво се счупи — и кое блокче беше виновно?**
Това е умната част.

Представи си сто деца, които едновременно посягат към **едно и също** Лего
блокче. Само едно дете го взима. Другите деветдесет и девет си тръгват с празни
ръце.

Нашият инструмент не казва просто „много деца не успяха". Той сочи точно към
блокчето и казва: **„това. Ето за това се бият всички."**

Това е разликата между „нещо не е наред" и „ето кое трябва да се поправи".

### Наистина ли откри нещо?

Да — и това е най-хубавото.

Изпитахме чужда машина. Истински код, написан от известна компания
(OpenZeppelin), не от нас.

Всички предполагаха, че бавното място е голямото централно блокче — „фабриката",
през която минава всяко плащане. Изглеждаше очевидно: всеки я докосва.

**Не беше тя.** Фабриката беше добре. Тя изобщо не се биеше с никого.

Истинската борба беше за **монетите**. Всяко плащане трябва да избере монета,
която да похарчи. Когато две плащания сграбчат една и съща монета в един и същи
момент, едното губи — защото монетата вече я няма.

Значи отговорът не беше „направете фабриката по-бърза". Беше **„избирайте
по-умно коя монета да вземете"**. Никой не знаеше това преди. Собствените им
тестове не са могли да го открият, защото техните тестове проверяват дали
работи — а не какво става, когато сто души го правят едновременно.

### Още нещо, което измерихме

За да използваш машината, всеки път трябва да носиш със себе си малък запечатан
плик — доказателство, че имаш право. Той е малък, около половин страница текст.

Измерихме колко струва носенето на този плик.

Отговорът: за повечето хора — нищо. Но за най-нещастните прави чакането с
**45% по-дълго**. Никой не беше измервал това досега. Сега е записано.

### Защо всичко това има значение?

Защото банките подписват договори, в които пише *„това ще бъде бързо"*. Ако не
е, това не е просто неудобно — това е нарушено обещание, зад което стоят
адвокати.

Преди нас екипите разбираха колко бърза е машината им **след** като я пуснат.

Сега могат да разберат предварително.
